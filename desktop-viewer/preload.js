"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("viewerApi", Object.freeze({
  status: () => ipcRenderer.invoke("viewer:status"),
  open: () => ipcRenderer.invoke("viewer:open"),
  reload: () => ipcRenderer.invoke("viewer:reload"),
  hide: () => ipcRenderer.invoke("viewer:hide"),
  quit: () => ipcRenderer.invoke("viewer:quit"),
  copyAnswer: () => ipcRenderer.invoke("viewer:copy"),
  clearView: () => ipcRenderer.invoke("viewer:clear"),
  toggleTheme: () => ipcRenderer.invoke("viewer:theme"),
  setIconVisible: value => ipcRenderer.invoke("viewer:icon", value),
  copyDiagnostics: () => ipcRenderer.invoke("viewer:diagnostics"),
  setPinned: value => ipcRenderer.invoke("viewer:pin", value),
  adjustOpacity: delta => ipcRenderer.invoke("viewer:opacity", delta),
  setClickThrough: value => ipcRenderer.invoke("viewer:clickThrough", value),
  setPointerOverToolbar: over => ipcRenderer.invoke("viewer:pointer", over),
  setToolbarVisible: visible => ipcRenderer.invoke("viewer:toolbar", visible),
  onStatus: callback => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("viewer:status-changed", handler);
    return () => ipcRenderer.removeListener("viewer:status-changed", handler);
  }
}));
