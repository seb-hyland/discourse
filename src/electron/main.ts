import { existsSync, realpathSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell, type MenuItemConstructorOptions } from "electron";
import type { ViteDevServer } from "vite";
import type { CommentUpdate, NewComment } from "../shared/api.ts";
import { openInEditor, type SettingsError } from "../workspace/editor.ts";
import { Workspace } from "../workspace/workspace.ts";
import { describe, recentFolders, rememberFolder } from "./recents.ts";
import { settings, settingsFile } from "./settings.ts";

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

async function openFolder(root: string) {
  const open = [...folders.values()].find((f) => f.root === root);
  if (open) return open.window.focus();
  let workspace: Workspace;
  try {
    workspace = await Workspace.open(root);
  } catch (e) {
    return dialog.showErrorBox(`Can't open ${basename(root)}`, (e as Error).message);
  }
  const id = `f${nextId++}`;
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: basename(root),
    backgroundColor: BACKGROUND,
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs") },
  });
  folders.set(id, { root, window, workspace });
  const stopWatching = workspace.watch((change) => window.isDestroyed() || window.webContents.send("change", change));
  void workspace.repinAll();
  window.on("page-title-updated", (e) => e.preventDefault());
  window.on("closed", () => {
    folders.delete(id);
    void stopWatching.then((stop) => stop());
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  await load(window, id);
  await rememberFolder(root);
  start?.close();
}

/**
 * Answers `channel` from the preload script with `{ value }` or `{ error, action }`, as Electron
 * would otherwise prefix error messages with its own. `run` gets the sender's folder, if it has one.
 */
function handle(channel: string, run: (folder: Folder, ...args: any[]) => unknown) {
  ipcMain.handle(channel, async (e, ...args) => {
    const folder = [...folders.values()].find((f) => f.window.webContents === e.sender);
    try {
      return { value: await run(folder!, ...args) };
    } catch (err) {
      return { error: (err as Error).message, action: (err as SettingsError).action };
    }
  });
}

/** Handles a change to a document's comments, answering with the document as it is now. */
function handleChange<A extends unknown[]>(channel: string, change: (workspace: Workspace, path: string, ...args: A) => Promise<void>) {
  handle(channel, async ({ workspace }, path: string, ...args: A) => {
    await change(workspace, path, ...args);
    return workspace.view(path);
  });
}

handle("files", ({ workspace }) => workspace.files());
handle("document", ({ workspace }, path: string) => workspace.view(path));
handleChange("add", (w, path, comment: NewComment) => w.add(path, comment));
handleChange("update", (w, path, id: string, update: CommentUpdate) => w.update(path, id, update));
handleChange("remove", (w, path, id: string) => w.remove(path, id));
handleChange("undo", (w, path, direction: "undo" | "redo") => w.undo(path, direction));
handleChange("resolveConflict", (w, path, id: string, version: number) => w.resolveConflict(path, id, version));
handleChange("restoreParent", (w, path, replyId: string) => w.restoreParent(path, replyId));
handleChange("restoreDocument", (w, path) => w.restoreDocument(path));
handle("openInEditor", async ({ workspace }, path: string, line: number, column: number) => {
  await openInEditor((await settings()).editor, workspace.documentPath(path), line, column);
});
handle("openCommentFile", async ({ workspace }, file: string) => {
  await openInEditor((await settings()).editor, workspace.commentFilePath(file), 1, 1);
});
handle("openFile", async ({ workspace }, path: string) => {
  const file = workspace.documentPath(path);
  if (!existsSync(file)) throw new Error(`${path} doesn't exist.`);
  if (!OPENABLE.has(extname(file).toLowerCase())) return shell.showItemInFolder(file);
  const failure = await shell.openPath(file);
  if (failure) throw new Error(`Couldn't open ${path}: ${failure}`);
});
handle("editSettings", () => editSettings());
handle("recents", async () => (await recentFolders()).map(describe));
handle("open", async (_, root: string) => {
  // Only folders the start window was offered.
  if ((await recentFolders()).includes(root)) await openFolder(root);
});
handle("choose", () => chooseFolder());

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

/** Opens the settings file in the editor it sets, or the file's default app if that doesn't work. */
async function editSettings() {
  const file = await settingsFile();
  try {
    await openInEditor((await settings()).editor, file, 1, 1);
  } catch {
    await shell.openPath(file);
  }
}

const appMenu: MenuItemConstructorOptions = {
  role: "appMenu",
  submenu: [
    { role: "about" },
    { type: "separator" },
    { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => void editSettings() },
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

const menu: MenuItemConstructorOptions[] = [
  ...(process.platform === "darwin" ? [appMenu] : []),
  {
    label: "File",
    submenu: [
      { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void chooseFolder() },
      { type: "separator" },
      { role: "close" },
    ],
  },
  { role: "editMenu" },
  { role: "viewMenu" },
  {
    label: "Go",
    submenu: [
      { label: "Back", accelerator: "CmdOrCtrl+[", click: () => go("back") },
      { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => go("forward") },
    ],
  },
  { role: "windowMenu" },
];

// Not awaited: Electron is only ready once this module has finished loading.
void app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
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
  const argument = process.argv
    .slice(1)
    .find((arg) => !arg.startsWith("-") && ![app.getAppPath(), import.meta.filename].includes(resolve(arg)));
  const root = argument && existsSync(argument) ? realpathSync(resolve(argument)) : null;
  if (argument && !root) dialog.showErrorBox(`Can't open ${argument}`, "There's no such folder.");
  if (root) await openFolder(root);
  else showStart();
});
