// The windows' bridge to the main process. CommonJS, as sandboxed preload scripts must be.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("discourse", {
    // The main process answers with { value } or { error, action } (see `handle` in main.ts).
    async invoke(channel, ...args) {
        const result = await ipcRenderer.invoke(channel, ...args);
        if ("error" in result) throw Object.assign(new Error(result.error), { action: result.action });
        return result.value;
    },
    onChange(listener) {
        const forward = (_event, change) => listener(change);
        ipcRenderer.on("change", forward);
        return () => ipcRenderer.removeListener("change", forward);
    },
});
