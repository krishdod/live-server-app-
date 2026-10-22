const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const VIEWER_URL = "http://localhost:8765/?overlay=1&role=view";
let done = false;
let currentOpacity = 0.92;
let clickThrough = false;

ipcMain.handle("overlay:set-opacity", (_e, value) => {
  currentOpacity = Math.min(1, Math.max(0.35, Number(value) || currentOpacity));
  return currentOpacity;
});
ipcMain.handle("overlay:get-opacity", () => currentOpacity);
ipcMain.handle("overlay:set-click-through", (_e, enabled) => {
  clickThrough = Boolean(enabled);
  return clickThrough;
});
ipcMain.handle("overlay:toggle-click-through", () => {
  clickThrough = !clickThrough;
  return clickThrough;
});
ipcMain.handle("overlay:close", () => {});
ipcMain.handle("overlay:minimize", () => {});

function finish(code, message) {
  if (done) return;
  done = true;
  console.log(message);
  app.exit(code);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 500,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const timer = setTimeout(() => {
    finish(1, "SMOKE_FAIL timed out loading viewer");
  }, 15000);

  win.webContents.on("did-fail-load", (_e, code, desc) => {
    clearTimeout(timer);
    finish(1, `SMOKE_FAIL did-fail-load ${code} ${desc}`);
  });

  win.webContents.on("did-finish-load", async () => {
    try {
      // Give overlay + async auth init time
      await new Promise((r) => setTimeout(r, 400));
      const result = await win.webContents.executeJavaScript(`({
        overlay: document.documentElement.classList.contains('overlay-mode'),
        practice: !!document.getElementById('practiceLabel'),
        api: !!(window.overlayAPI && window.overlayAPI.isOverlay),
        title: document.title,
        transparentBtn: !!document.getElementById('transparentBtn'),
        role: document.getElementById('roleBadge')?.textContent || '',
        isViewOnly: document.getElementById('answer')?.classList.contains('view-only'),
        solidDefault: !document.body.classList.contains('overlay-transparent'),
        themeBtnHidden: getComputedStyle(document.getElementById('themeBtn')).display === 'none'
      })`);
      clearTimeout(timer);
      if (!result.overlay || !result.practice || !result.api || !result.transparentBtn || !result.isViewOnly || !result.themeBtnHidden) {
        finish(1, `SMOKE_FAIL missing bits ${JSON.stringify(result)}`);
        return;
      }
      finish(0, `SMOKE_OK ${JSON.stringify(result)}`);
    } catch (err) {
      clearTimeout(timer);
      finish(1, `SMOKE_FAIL executeJavaScript ${err.message}`);
    }
  });

  win.loadURL(VIEWER_URL);
});
