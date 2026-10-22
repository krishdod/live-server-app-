const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayAPI", {
  isOverlay: true,

  setOpacity(value) {
    return ipcRenderer.invoke("overlay:set-opacity", value);
  },

  getOpacity() {
    return ipcRenderer.invoke("overlay:get-opacity");
  },

  setClickThrough(enabled) {
    return ipcRenderer.invoke("overlay:set-click-through", enabled);
  },

  toggleClickThrough() {
    return ipcRenderer.invoke("overlay:toggle-click-through");
  },

  close() {
    return ipcRenderer.invoke("overlay:close");
  },

  minimize() {
    return ipcRenderer.invoke("overlay:minimize");
  },

  onClickThroughChanged(callback) {
    const handler = (_event, enabled) => callback(enabled);
    ipcRenderer.on("overlay:click-through-changed", handler);
    return () => ipcRenderer.removeListener("overlay:click-through-changed", handler);
  },

  onOpacityChanged(callback) {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("overlay:opacity-changed", handler);
    return () => ipcRenderer.removeListener("overlay:opacity-changed", handler);
  },
});
