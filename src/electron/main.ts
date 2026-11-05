import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell, type MenuItemConstructorOptions } from "electron";
import type { ViteDevServer } from "vite";
import type { CommentUpdate, NewComment } from "../shared/api.ts";
import { openInEditor } from "../workspace/editor.ts";
import { Workspace } from "../workspace/workspace.ts";
import { describe, recentFolders, rememberFolder } from "./recents.ts";
import { settings, settingsFile } from "./settings.ts";

const BACKGROUND = "#fff5ed";

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
  const stopWatching = workspace.watch((change) => window.webContents.send("change", change));
  window.on("page-title-updated", (e) => e.preventDefault());
  window.on("closed", () => {
    folders.delete(id);
    void stopWatching();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  await (vite
    ? window.loadURL(`${vite.resolvedUrls!.local[0]}?folder=${id}`)
    : window.loadFile(join(import.meta.dirname, "../../dist/index.html"), { query: { folder: id } }));
  await rememberFolder(root);
  start?.close();
}

/**
 * Answers `channel` from the preload script with `{ value }` or `{ error }`, as Electron would
 * otherwise prefix error messages with its own. `run` gets the sender's folder, if it has one.
 */
function handle(channel: string, run: (folder: Folder, ...args: any[]) => unknown) {
  ipcMain.handle(channel, async (e, ...args) => {
    const folder = [...folders.values()].find((f) => f.window.webContents === e.sender);
    try {
      return { value: await run(folder!, ...args) };
    } catch (err) {
      return { error: (err as Error).message };
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
handleChange("undo", (w, path, redo: boolean) => w.undo(path, redo ? "redo" : "undo"));
handleChange("resolveConflict", (w, path, id: string, version: number) => w.resolveConflict(path, id, version));
handleChange("restoreParent", (w, path, replyId: string) => w.restoreParent(path, replyId));
handle("openInEditor", async ({ workspace }, path: string, offset: number) => {
  const { line, column } = await workspace.position(path, offset);
  await openInEditor((await settings()).editor, workspace.documentPath(path), line, column);
});
handle("openFile", async ({ workspace }, path: string) => {
  const file = workspace.documentPath(path);
  if (!existsSync(file)) throw new Error(`${path} doesn't exist.`);
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
  void start.loadFile(join(import.meta.dirname, "start.html"));
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
  if (argument) await openFolder(realpathSync(resolve(argument)));
  else showStart();
});
