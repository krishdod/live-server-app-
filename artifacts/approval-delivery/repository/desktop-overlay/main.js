const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const RETRY_MS = 1500;
const MAX_RETRIES = 40;

let overlayWindow = null;
let setupWindow = null;
let clickThrough = false;
let currentOpacity = 1;
let loadRetries = 0;
let viewerUrl = "";
let retryTimer = null;

function getConfigPath() {
  if (app.isPackaged) {
    return path.join(path.dirname(process.execPath), "overlay-config.json");
  }
  return path.join(__dirname, "overlay-config.json");
}

function readConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data.viewerUrl === "string" && data.viewerUrl.trim()) {
      return data.viewerUrl.trim();
    }
  } catch {
    // missing or invalid
  }
  return typeof process.env.OVERLAY_URL === "string" ? process.env.OVERLAY_URL.trim() : "";
}

function writeConfig(url) {
  const payload = {
    viewerUrl: String(url || "").trim(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(payload, null, 2), "utf8");
}

function ensureOverlayParams(url) {
  try {
    const u = new URL(String(url).trim());
    if (!u.searchParams.has("overlay")) u.searchParams.set("overlay", "1");
    if (!u.searchParams.has("role")) u.searchParams.set("role", "view");
    return u.toString();
  } catch {
    return String(url || "").trim();
  }
}

function isSafeViewerUrl(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    // Block file/data/javascript schemes and empty hosts
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 620,
    height: 480,
    resizable: false,
    maximizable: false,
    title: "Live Workspace Overlay — Setup",
    backgroundColor: "#0b0d12",
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  setupWindow.loadFile(path.join(__dirname, "setup.html"));
  setupWindow.on("closed", () => {
    setupWindow = null;
    if (!overlayWindow) app.quit();
  });
}

function createOverlay(url) {
  viewerUrl = ensureOverlayParams(url);
  loadRetries = 0;
  clearRetryTimer();

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(920, Math.floor(screenW * 0.55));
  const winH = Math.min(560, Math.floor(screenH * 0.55));

  overlayWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.floor((screenW - winW) / 2),
    y: Math.floor(screenH * 0.08),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    hasShadow: true,
    thickFrame: false,
    skipTaskbar: false,
    backgroundColor: "#00000000",
    // Show immediately — waiting for remote Render made startup feel frozen
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Faster first paint for remote viewer
      backgroundThrottling: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setOpacity(currentOpacity);

  // Instant local loading shell while Render wakes / page loads
  overlayWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html><html><body style="margin:0;background:rgba(10,12,18,.88);color:#e8eaed;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
        <div style="text-align:center">
          <div style="font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fbbf24;margin-bottom:10px">Practice Mode</div>
          <div style="font-size:15px">Connecting to Live Workspace…</div>
          <div style="font-size:12px;color:#9aa3af;margin-top:8px">First open after idle can take ~30s on free Render</div>
        </div>
      </body></html>`)
  );

  overlayWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    // Ignore failures from the temporary data: loading shell
    if (String(validatedURL || "").startsWith("data:")) return;

    if (loadRetries >= MAX_RETRIES) {
      console.error(
        `[overlay] Could not reach ${viewerUrl} after ${MAX_RETRIES} tries.`,
        errorDescription || errorCode
      );
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.loadURL(
          "data:text/html;charset=utf-8," +
            encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#111;color:#eee;font-family:Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px">
              <div>
                <h2 style="font-weight:500">Could not connect</h2>
                <p style="color:#aaa">Open the viewer link in Chrome first to wake the server, then reopen this app.</p>
              </div>
            </body></html>`)
        );
      }
      return;
    }
    loadRetries += 1;
    console.warn(
      `[overlay] Viewer not ready (${errorDescription || errorCode}). Retry ${loadRetries}/${MAX_RETRIES}…`
    );
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.loadURL(viewerUrl);
      }
    }, RETRY_MS);
  });

  overlayWindow.webContents.on("did-finish-load", () => {
    const current = overlayWindow?.webContents?.getURL?.() || "";
    if (current.startsWith("data:")) return;
    loadRetries = 0;
    clearRetryTimer();
  });

  // Wake Render, then load the real viewer (avoids long blank wait)
  wakeThenLoad(viewerUrl);

  if (process.argv.includes("--devtools")) {
    overlayWindow.webContents.openDevTools({ mode: "detach" });
  }

  overlayWindow.on("closed", () => {
    clearRetryTimer();
    overlayWindow = null;
  });

  overlayWindow.on("focus", () => {
    registerShortcuts();
  });

  overlayWindow.on("blur", () => {
    try {
      globalShortcut.unregisterAll();
    } catch {
      // ignore
    }
  });
}

async function wakeThenLoad(url) {
  try {
    const origin = new URL(url).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    await fetch(`${origin}/health`, { method: "GET", cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
  } catch {
    // Still try loading the viewer — retries handle cold starts
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.loadURL(url);
  }
}

function startApp() {
  const saved = readConfig();
  if (saved && isSafeViewerUrl(saved)) {
    createOverlay(saved);
    registerShortcuts();
    return;
  }
  createSetupWindow();
}

function registerShortcuts() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignore
  }

  // Only meaningful while overlay is focused (registered on focus).
  globalShortcut.register("Alt+]", () => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isFocused()) return;
    currentOpacity = Math.min(1, Math.round((currentOpacity + 0.05) * 100) / 100);
    overlayWindow.setOpacity(currentOpacity);
    overlayWindow.webContents.send("overlay:opacity-changed", currentOpacity);
  });

  globalShortcut.register("Alt+[", () => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isFocused()) return;
    currentOpacity = Math.max(0.35, Math.round((currentOpacity - 0.05) * 100) / 100);
    overlayWindow.setOpacity(currentOpacity);
    overlayWindow.webContents.send("overlay:opacity-changed", currentOpacity);
  });

  globalShortcut.register("Alt+\\", () => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isFocused()) return;
    clickThrough = !clickThrough;
    overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
    overlayWindow.webContents.send("overlay:click-through-changed", clickThrough);
  });
}

ipcMain.handle("setup:get-url", () => readConfig());

ipcMain.handle("setup:unlock-and-open", async (_event, payload) => {
  const saved = readConfig();
  const cleaned = String(payload?.url || saved || "").trim();

  if (!isSafeViewerUrl(cleaned)) {
    throw new Error("Enter a valid http(s) viewer URL");
  }

  writeConfig(cleaned);
  const finalUrl = ensureOverlayParams(cleaned);

  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
    setupWindow = null;
  }

  createOverlay(finalUrl);
  registerShortcuts();
  return true;
});

ipcMain.handle("overlay:set-opacity", (_event, value) => {
  const next = Math.min(1, Math.max(0.35, Number(value) || currentOpacity));
  currentOpacity = next;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setOpacity(currentOpacity);
  }
  return currentOpacity;
});

ipcMain.handle("overlay:get-opacity", () => currentOpacity);

ipcMain.handle("overlay:set-click-through", (_event, enabled) => {
  clickThrough = Boolean(enabled);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
    overlayWindow.webContents.send("overlay:click-through-changed", clickThrough);
  }
  return clickThrough;
});

ipcMain.handle("overlay:toggle-click-through", () => {
  clickThrough = !clickThrough;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
    overlayWindow.webContents.send("overlay:click-through-changed", clickThrough);
  }
  return clickThrough;
});

ipcMain.handle("overlay:close", () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
});

ipcMain.handle("overlay:minimize", () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.minimize();
  }
});

app.whenReady().then(() => {
  startApp();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startApp();
    }
  });
});

app.on("will-quit", () => {
  clearRetryTimer();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
