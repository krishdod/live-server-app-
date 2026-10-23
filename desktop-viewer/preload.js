"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("viewerApi", Object.freeze({
  status: () => ipcRenderer.invoke("viewer:status"),
  open: url => ipcRenderer.invoke("viewer:open", url),
  reload: () => ipcRenderer.invoke("viewer:reload"),
  hide: () => ipcRenderer.invoke("viewer:hide"),
  quit: () => ipcRenderer.invoke("viewer:quit"),
  setPinned: value => ipcRenderer.invoke("viewer:pin", value),
  adjustOpacity: delta => ipcRenderer.invoke("viewer:opacity", delta),
  setClickThrough: value => ipcRenderer.invoke("viewer:clickThrough", value),
  setPointerOverToolbar: over => ipcRenderer.invoke("viewer:pointer", over),
  setLinkBarVisible: visible => ipcRenderer.invoke("viewer:linkBar", visible),
  setToolbarVisible: visible => ipcRenderer.invoke("viewer:toolbar", visible),
  onStatus: callback => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("viewer:status-changed", handler);
    return () => ipcRenderer.removeListener("viewer:status-changed", handler);
  }
}));
