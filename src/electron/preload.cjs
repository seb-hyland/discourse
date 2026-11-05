// The windows' bridge to the main process. CommonJS, as sandboxed preload scripts must be.
const { contextBridge, ipcRenderer } = require("electron");

// The main process answers with { value } or { error } (see `handle` in main.ts).
const call = (channel) => async (...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if ("error" in result) throw new Error(result.error);
  return result.value;
};

const channels = ["files", "document", "add", "update", "remove", "undo", "resolveConflict", "restoreParent", "openInEditor", "openFile", "editSettings", "recents", "open", "choose"];

contextBridge.exposeInMainWorld("discourse", {
  ...Object.fromEntries(channels.map((channel) => [channel, call(channel)])),
  onChange(listener) {
    const forward = (_event, change) => listener(change);
    ipcRenderer.on("change", forward);
    return () => ipcRenderer.removeListener("change", forward);
  },
});
