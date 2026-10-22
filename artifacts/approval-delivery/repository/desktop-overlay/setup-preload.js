const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlaySetup", {
  getSavedUrl() {
    return ipcRenderer.invoke("setup:get-url");
  },
  unlockAndOpen(payload) {
    return ipcRenderer.invoke("setup:unlock-and-open", payload);
  },
});
