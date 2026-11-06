import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell, type MenuItemConstructorOptions } from "electron";
import type { ViteDevServer } from "vite";
import type { Bridge, CommentUpdate, DocumentView, NewComment } from "../shared/api.ts";
import { openInEditor, type SettingsError } from "../workspace/editor.ts";
import { Workspace } from "../workspace/workspace.ts";
import { describe, forgetFolders, recentFolders, rememberFolder } from "./recents.ts";
import { settings, settingsFile } from "./settings.ts";
import { rememberBounds, windowBounds } from "./windowState.ts";

const BACKGROUND = "#fff5ed";

/** Files a link may open in their default app; anything else linked to is only shown in its folder. */
const OPENABLE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tiff", ".bmp"]);

interface Folder {
    root: string;
    window: BrowserWindow;
    workspace: Workspace;
}

/** Open folders, by the id their window's UI is given; files in them are at `workspace://<id>/<path>`. */
const folders = new Map<string, Folder>();
let nextId = 1;
/** The window listing recent folders, shown when no folder is open. */
let start: BrowserWindow | null = null;
/** Serves the UI in development, with live reload. Packaged, the UI is the files `vite build` made. */
let vite: ViteDevServer | null = null;

protocol.registerSchemesAsPrivileged([{ scheme: "workspace", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/** Where which of a folder's comments have been read is kept: on this computer, as it's the user's own. */
const seenFile = (root: string) => join(app.getPath("userData"), "seen", `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

async function openFolder(root: string) {
    const open = [...folders.values()].find((f) => f.root === root);
    if (open) return open.window.focus();
    let workspace: Workspace;
    try {
        workspace = await Workspace.open(root, seenFile(root));
    } catch (e) {
        return dialog.showErrorBox(`Can't open ${basename(root)}`, (e as Error).message);
    }
    const id = `f${nextId++}`;
    const window = new BrowserWindow({
        ...windowBounds(folders.size > 0),
        title: basename(root),
        backgroundColor: BACKGROUND,
        webPreferences: { preload: join(import.meta.dirname, "preload.cjs") },
    });
    folders.set(id, { root, window, workspace });
    const stopWatching = workspace.watch((change) => window.isDestroyed() || window.webContents.send("change", change));
    void workspace.settleAll();
    rememberBounds(window);
    window.on("page-title-updated", (e) => e.preventDefault());
    window.webContents.on("did-navigate-in-page", updateGo);
    // A three-finger swipe, where the trackpad is set up for it (two-finger ones are seen by the window).
    window.on("swipe", (_, direction) => (direction === "left" ? go("back") : direction === "right" ? go("forward") : undefined));
    window.on("closed", () => {
        folders.delete(id);
        void stopWatching.then((stop) => stop());
        workspace.seen.flush();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
        return { action: "deny" };
    });
    await load(window, id);
    await rememberFolder(root);
    app.addRecentDocument(root);
    await updateMenu();
    start?.close();
}

/**
 * Opens a folder from outside the app: given on the command line, or sent by macOS (dropped on the
 * Dock icon, picked in Finder's Open With, or from `open`).
 */
async function openFromOutside(path: string) {
    const isFolder = (() => {
        try {
            return statSync(path).isDirectory();
        } catch {
            return false;
        }
    })();
    if (!isFolder) return dialog.showErrorBox(`Can't open ${basename(path)}`, existsSync(path) ? "Only folders can be opened." : "There's no such folder.");
    await openFolder(realpathSync(path));
}

/**
 * macOS sends folders to open as events, not on the command line, from before the app is ready
 * (when they're why it was launched) to whenever it's running. Those from before wait for it.
 */
const sentBeforeReady: string[] = [];
app.on("open-file", (e, path) => {
    e.preventDefault();
    if (app.isReady()) void openFromOutside(path);
    else sentBeforeReady.push(path);
});

/** The calls a window can make, each sent on the channel of its name (see `Bridge`). */
type Channel = Exclude<keyof Bridge, "onChange">;

/**
 * How the main process answers each of `Bridge`'s calls, given the sender's folder (unset for the
 * start window) and the call's arguments. Typed against `Bridge`, so the two can't drift apart.
 */
type Handlers = {
    [C in Channel]: (folder: Folder, ...args: Parameters<Bridge[C]>) => ReturnType<Bridge[C]> | Awaited<ReturnType<Bridge[C]>>;
};

/** A change to a document's comments, answering with the document as it is now. */
const change =
    <A extends unknown[]>(run: (workspace: Workspace, path: string, ...args: A) => Promise<void>) =>
    async ({ workspace }: Folder, path: string, ...args: A): Promise<DocumentView> => {
        await run(workspace, path, ...args);
        return workspace.view(path);
    };

const handlers: Handlers = {
    files: ({ workspace }) => workspace.files(),
    document: ({ workspace }, path) => workspace.view(path),
    add: change((w, path, comment: NewComment) => w.add(path, comment)),
    update: change((w, path, id: string, update: CommentUpdate) => w.update(path, id, update)),
    remove: change((w, path, id: string) => w.remove(path, id)),
    undo: change((w, path, direction: "undo" | "redo") => w.undo(path, direction)),
    resolveConflict: change((w, path, id: string, version: number | "both") => w.resolveConflict(path, id, version)),
    restoreParent: change((w, path, replyId: string) => w.restoreParent(path, replyId)),
    restoreDocument: change((w, path) => w.restoreDocument(path)),
    openInEditor: async ({ workspace }, path, line, column) => {
        await openInEditor((await settings()).editor, workspace.documentPath(path), line, column);
    },
    openCommentFile: async ({ workspace }, file) => {
        await openInEditor((await settings()).editor, workspace.commentFilePath(file), 1, 1);
    },
    openFile: async ({ workspace }, path) => {
        const file = workspace.documentPath(path);
        if (!existsSync(file)) throw new Error(`${path} doesn't exist.`);
        if (!OPENABLE.has(extname(file).toLowerCase())) return shell.showItemInFolder(file);
        const failure = await shell.openPath(file);
        if (failure) throw new Error(`Couldn't open ${path}: ${failure}`);
    },
    editSettings: () => editSettings(),
    search: ({ workspace }, query, within) => workspace.search(query, within),
    allThreads: ({ workspace }) => workspace.allThreads(),
    markSeen: ({ workspace }, versions) => workspace.markSeen(versions),
    unreadOnFirstOpen: ({ workspace }) => workspace.unreadOnFirstOpen(),
    markAllSeen: async ({ workspace }) => {
        await workspace.markAllSeen();
        return workspace.allThreads();
    },
    recents: async () => (await recentFolders()).map(describe),
    open: async (_, root) => {
        // Only folders the start window was offered.
        if ((await recentFolders()).includes(root)) await openFolder(root);
        else dialog.showErrorBox(`Can't open ${basename(root)}`, "It's been moved or deleted.");
    },
    choose: () => chooseFolder(),
    forget: async (_, root) => {
        if (root === undefined) return clearRecents();
        await forgetFolders(root);
        await updateMenu();
        return (await recentFolders()).map(describe);
    },
};

/**
 * Answers each channel from the preload script with `{ value }` or `{ error, action }`, as Electron
 * would otherwise prefix error messages with its own.
 */
for (const [channel, run] of Object.entries(handlers) as [Channel, (folder: Folder, ...args: unknown[]) => unknown][]) {
    ipcMain.handle(channel, async (e, ...args) => {
        const folder = [...folders.values()].find((f) => f.window.webContents === e.sender);
        try {
            return { value: await run(folder!, ...args) };
        } catch (err) {
            return { error: (err as Error).message, action: (err as SettingsError).action };
        }
    });
}

async function chooseFolder() {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (!canceled) await openFolder(realpathSync(filePaths[0]));
}

/** Loads the UI: a folder's, by its id, or without one the start window's. */
function load(window: BrowserWindow, folder?: string) {
    const query: Record<string, string> = folder ? { folder } : {};
    return vite
        ? window.loadURL(`${vite.resolvedUrls!.local[0]}?${new URLSearchParams(query)}`)
        : window.loadFile(join(import.meta.dirname, "../../dist/index.html"), { query });
}

function showStart() {
    if (start) return start.focus();
    start = new BrowserWindow({
        width: 480,
        height: 440,
        resizable: false,
        backgroundColor: BACKGROUND,
        webPreferences: { preload: join(import.meta.dirname, "preload.cjs") },
    });
    start.on("closed", () => (start = null));
    void load(start);
}

/** Goes back or forward through the files and comments opened in the focused window. */
function go(direction: "back" | "forward") {
    const history = BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
    if (direction === "back" && history?.canGoBack()) history.goBack();
    if (direction === "forward" && history?.canGoForward()) history.goForward();
}

/** Enables Go › Back and Forward only when the focused window has somewhere to go. */
function updateGo() {
    const history = BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
    const menu = Menu.getApplicationMenu();
    menu!.getMenuItemById("back")!.enabled = !!history?.canGoBack();
    menu!.getMenuItemById("forward")!.enabled = !!history?.canGoForward();
}

/**
 * Opens the settings file in the editor it sets, or the file's default app if that doesn't work,
 * failing with where the file is if neither can open it.
 */
async function editSettings() {
    const file = await settingsFile();
    try {
        await openInEditor((await settings()).editor, file, 1, 1);
    } catch {
        const failure = await shell.openPath(file);
        if (failure) throw new Error(`Couldn't open the settings, which are in ${file}`);
    }
}

/** Opens the settings from the menu, where there's no window to say why it couldn't. */
function editSettingsFromMenu() {
    editSettings().catch((e) => dialog.showErrorBox("Can't open settings", (e as Error).message));
}

const appMenu: MenuItemConstructorOptions = {
    role: "appMenu",
    submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: editSettingsFromMenu },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
    ],
};

const menu = (recents: string[]): MenuItemConstructorOptions[] => [
    ...(process.platform === "darwin" ? [appMenu] : []),
    {
        label: "File",
        submenu: [
            { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void chooseFolder() },
            {
                label: "Open Recent",
                submenu: [
                    ...recents.map((root): MenuItemConstructorOptions => {
                        const { name, location } = describe(root);
                        return { label: `${name} — ${location}`, click: () => void openFolder(root) };
                    }),
                    { type: "separator" },
                    {
                        label: "Clear Menu",
                        enabled: recents.length > 0,
                        click: async () => {
                            await clearRecents();
                            // The start window lists them too.
                            start?.webContents.reload();
                        },
                    },
                ],
            },
            { type: "separator" },
            { role: "close" },
        ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
        label: "Go",
        submenu: [
            { id: "back", label: "Back", accelerator: "CmdOrCtrl+[", click: () => go("back") },
            { id: "forward", label: "Forward", accelerator: "CmdOrCtrl+]", click: () => go("forward") },
        ],
    },
    { role: "windowMenu" },
];

/** Builds the menu afresh, as Open Recent changes. */
async function updateMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu(await recentFolders())));
    updateGo();
}

/** Forgets recent folders, here and in the Dock (which can only forget them all). */
async function clearRecents() {
    await forgetFolders();
    app.clearRecentDocuments();
    await updateMenu();
    return [];
}

// Not awaited: Electron is only ready once this module has finished loading.
void app.whenReady().then(async () => {
    await updateMenu();
    app.on("browser-window-focus", updateGo);
    protocol.handle("workspace", ({ url }) => {
        const { host, pathname } = new URL(url);
        try {
            return net.fetch(pathToFileURL(folders.get(host)!.workspace.documentPath(decodeURIComponent(pathname.slice(1)))).href);
        } catch {
            return new Response(null, { status: 404 });
        }
    });
    if (!app.isPackaged) {
        const { createServer } = await import("vite");
        vite = await createServer({ configFile: join(import.meta.dirname, "../../vite.config.ts") });
        await vite.listen();
        app.on("will-quit", () => void vite?.close());
    }
    app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && showStart());
    app.on("window-all-closed", () => process.platform === "darwin" || app.quit());

    // A folder given on the command line (not a flag, nor the app's own path when run unpackaged), or
    // the start window to pick one.
    const argument = process.argv.slice(1).find((arg) => !arg.startsWith("-") && ![app.getAppPath(), import.meta.filename].includes(resolve(arg)));
    const sent = [...(argument ? [resolve(argument)] : []), ...sentBeforeReady.splice(0)];
    for (const path of sent) await openFromOutside(path);
    if (folders.size === 0) showStart();
});
