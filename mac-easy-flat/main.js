"use strict";
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { normalizeViewerUrl, allowedNavigation, supportsCaptureExclusion } = require("./policy");

const HEADER_HEIGHT = 176;
const COMPACT_HEADER_HEIGHT = 128;
const TOGGLE_SHORTCUT = "Control+Alt+V";
const PIN_SHORTCUT = "Control+Alt+T";
const OPACITY_UP_SHORTCUT = "Control+Alt+=";
const OPACITY_DOWN_SHORTCUT = "Control+Alt+-";
const CLICK_THROUGH_SHORTCUT = "Control+Alt+C";
const OPACITY_STEP = 0.05;
const MIN_OPACITY = 0.2;
const MAX_OPACITY = 1;
const CHANNELS = ["status", "open", "reload", "hide", "quit", "pin", "opacity", "clickThrough", "pointer", "linkBar"]
  .map(name => `viewer:${name}`);

function createViewer(electron, options = {}) {
  const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, session, screen } = electron;
  const supported = supportsCaptureExclusion(options.platform ?? process.platform, options.release ?? os.release());
  const homePath = path.join(__dirname, "home.html");
  const homeUrl = pathToFileURL(homePath).href;
  let protectedContent = false;
  let shortcut = false;
  let pinShortcut = false;
  let opacityUpShortcut = false;
  let opacityDownShortcut = false;
  let clickThroughShortcut = false;
  let pinned = true;
  let opacity = 1;
  let clickThrough = false;
  let pointerOverToolbar = true;
  let linkHidden = false;
  let headerHeight = HEADER_HEIGHT;
  let pointerPoll = null;
  let view = null;
  let viewerUrl = "";
  let loadGeneration = 0;
  let closed = false;
  let message = "Open your viewer link. It will hide automatically while staying on top.";

  const win = new BrowserWindow({
    title: "Live Workspace Viewer", width: 880, height: 680,
    minWidth: 560, minHeight: 410, show: false, alwaysOnTop: true,
    skipTaskbar: false, backgroundColor: "#10151d", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, devTools: false
    }
  });
  win.setMenu(null);

  function applyPinned() {
    // screen-saver level keeps the window above normal apps, similar to PowerToys Always on Top.
    try { win.setAlwaysOnTop(pinned, pinned ? "screen-saver" : "normal"); }
    catch { win.setAlwaysOnTop(pinned); }
    // Keep the overlay available across macOS Spaces / full-screen meetings when pinned.
    if (typeof win.setVisibleOnAllWorkspaces === "function") {
      try { win.setVisibleOnAllWorkspaces(pinned, { visibleOnFullScreen: pinned }); }
      catch { /* unsupported on this host */ }
    }
  }
  function applyOpacity() {
    try { win.setOpacity(opacity); } catch { /* harness / unsupported */ }
  }
  function applyClickThrough() {
    if (closed) return;
    const ignore = clickThrough && !pointerOverToolbar;
    try { win.setIgnoreMouseEvents(ignore, { forward: true }); }
    catch {
      try { win.setIgnoreMouseEvents(ignore); } catch { /* harness / unsupported */ }
    }
  }
  function syncHeaderHeight() {
    headerHeight = linkHidden ? COMPACT_HEADER_HEIGHT : HEADER_HEIGHT;
  }
  function stopPointerPoll() {
    if (pointerPoll) {
      clearInterval(pointerPoll);
      pointerPoll = null;
    }
  }
  function refreshPointerPoll() {
    stopPointerPoll();
    if (!clickThrough || closed || !screen || typeof screen.getCursorScreenPoint !== "function") return;
    pointerPoll = setInterval(() => {
      if (closed || !clickThrough) return;
      try {
        if (typeof win.isVisible === "function" && !win.isVisible()) return;
        const point = screen.getCursorScreenPoint();
        const bounds = typeof win.getContentBounds === "function"
          ? win.getContentBounds()
          : { x: 0, y: 0, width: 0, height: 0 };
        const over = point.x >= bounds.x && point.x < bounds.x + bounds.width &&
          point.y >= bounds.y && point.y < bounds.y + headerHeight;
        if (over !== pointerOverToolbar) {
          pointerOverToolbar = over;
          applyClickThrough();
        }
      } catch { /* ignore transient window state errors */ }
    }, 40);
  }
  applyPinned();
  applyOpacity();
  applyClickThrough();

  function snapshot() {
    return {
      protection: protectedContent, supported, shortcut, pinShortcut,
      opacityUpShortcut, opacityDownShortcut, clickThroughShortcut,
      pinned, opacity, clickThrough, linkHidden, headerHeight, message
    };
  }
  function report(text) {
    message = text;
    if (!closed && !win.webContents.isDestroyed()) win.webContents.send("viewer:status-changed", snapshot());
  }
  function applyProtection() {
    if (!supported) return false;
    try {
      win.setContentProtection(true);
      return win.isContentProtected();
    } catch { return false; }
  }
  protectedContent = applyProtection();
  if (!protectedContent) message = "Capture protection is unavailable. The live page will not open on this system.";

  function restore() {
    if (closed) return;
    protectedContent = applyProtection();
    if (!protectedContent && view) {
      win.contentView.removeChildView(view);
      view.webContents.close();
      view = null;
      report("Capture protection could not be restored. Reopen the app before connecting.");
    }
    win.setSkipTaskbar(protectedContent && shortcut);
    applyPinned();
    applyOpacity();
    applyClickThrough();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  function hide() {
    if (shortcut && !closed) win.hide();
  }
  function setPinned(value) {
    pinned = value === true;
    applyPinned();
    return snapshot();
  }
  function togglePinned() {
    const status = setPinned(!pinned);
    report(pinned ? "Always on Top is on." : "Always on Top is off.");
    return status;
  }
  function adjustOpacity(delta) {
    const next = Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round((opacity + delta) * 100) / 100));
    opacity = next;
    applyOpacity();
    report(`Opacity ${Math.round(opacity * 100)}%`);
    return snapshot();
  }
  function setClickThrough(value) {
    clickThrough = value === true;
    if (!clickThrough) pointerOverToolbar = true;
    applyClickThrough();
    refreshPointerPoll();
    report(clickThrough
      ? "Click-through on — use apps behind this window. Hover the toolbar to control it."
      : "Click-through off — this window captures mouse input.");
    return snapshot();
  }
  function toggleClickThrough() {
    return setClickThrough(!clickThrough);
  }
  function setPointerOverToolbar(over) {
    pointerOverToolbar = over === true;
    applyClickThrough();
  }
  function setLinkBarVisible(visible) {
    linkHidden = visible !== true;
    syncHeaderHeight();
    resizeView();
    if (!closed && !win.webContents.isDestroyed()) win.webContents.send("viewer:status-changed", snapshot());
    return snapshot();
  }
  if (options.registerShortcut !== false) {
    try {
      shortcut = globalShortcut.register(TOGGLE_SHORTCUT, () => {
        if (win.isVisible() && !win.isMinimized()) hide(); else restore();
      });
    } catch { shortcut = false; }
    try {
      pinShortcut = globalShortcut.register(PIN_SHORTCUT, () => { togglePinned(); });
    } catch { pinShortcut = false; }
    try {
      opacityUpShortcut = globalShortcut.register(OPACITY_UP_SHORTCUT, () => { adjustOpacity(OPACITY_STEP); });
    } catch { opacityUpShortcut = false; }
    try {
      opacityDownShortcut = globalShortcut.register(OPACITY_DOWN_SHORTCUT, () => { adjustOpacity(-OPACITY_STEP); });
    } catch { opacityDownShortcut = false; }
    try {
      clickThroughShortcut = globalShortcut.register(CLICK_THROUGH_SHORTCUT, () => { toggleClickThrough(); });
    } catch { clickThroughShortcut = false; }
  }
  // Only leave the taskbar/Dock once a global recovery shortcut is registered.
  win.setSkipTaskbar(protectedContent && shortcut);
  if (!shortcut && protectedContent) {
    message = "Ctrl+Alt+V is unavailable. The viewer will stay on the taskbar/Dock.";
  }

  // Separate in-memory sessions prevent site storage/cookies crossing servers
  // and avoid saving key-bearing viewer links in app configuration.
  const viewerSession = session.fromPartition(`viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mayCopy = (wc, permission, origin) => Boolean(view && wc === view.webContents && viewerUrl &&
    permission === "clipboard-sanitized-write" && allowedNavigation(origin, viewerUrl));
  viewerSession.setPermissionRequestHandler((wc, permission, callback, details = {}) =>
    callback(mayCopy(wc, permission, details.requestingUrl || wc?.getURL?.())));
  viewerSession.setPermissionCheckHandler((wc, permission, origin) => mayCopy(wc, permission, origin));
  viewerSession.on("will-download", event => event.preventDefault());

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.webContents.on("page-title-updated", event => event.preventDefault());

  function resizeView() {
    if (!view || closed) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: headerHeight, width, height: Math.max(0, height - headerHeight) });
  }
  win.on("resize", resizeView);

  async function openViewer(raw) {
    if (closed) return { ok: false, error: "The viewer is closed." };
    let next;
    try { next = normalizeViewerUrl(raw); }
    catch (error) { return { ok: false, error: error.message }; }
    protectedContent = applyProtection();
    if (!protectedContent) {
      if (view) {
        win.contentView.removeChildView(view);
        view.webContents.close();
        view = null;
      }
      loadGeneration++;
      viewerUrl = "";
      report("Capture protection is unavailable. The live page was not opened.");
      return { ok: false, error: message };
    }
    const generation = ++loadGeneration;
    if (view) {
      win.contentView.removeChildView(view);
      view.webContents.close();
    }
    viewerUrl = next;
    const nextView = new WebContentsView({ webPreferences: {
      session: viewerSession, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, devTools: false,
      allowRunningInsecureContent: false, backgroundThrottling: false
    } });
    view = nextView;
    const wc = nextView.webContents;
    wc.setWindowOpenHandler(() => {
      report("A link tried to open another window. Use the existing viewer page.");
      return { action: "deny" };
    });
    const guardNavigation = (event, destination) => {
      // Support Electron's navigation event object and legacy URL argument.
      const target = typeof destination === "string" ? destination : event.url;
      if (!allowedNavigation(target, next)) {
        event.preventDefault();
        report("A link to another website was blocked. Paste a new viewer link above if needed.");
      }
    };
    wc.on("will-navigate", guardNavigation);
    wc.on("will-redirect", guardNavigation);
    wc.on("will-frame-navigate", guardNavigation);
    wc.on("will-attach-webview", event => event.preventDefault());
    wc.on("render-process-gone", () => report("The viewer stopped responding. Click Reload to reconnect."));
    win.contentView.addChildView(nextView);
    resizeView();
    report("Connecting… a sleeping server can take up to a minute.");
    try {
      await wc.loadURL(next);
      if (generation !== loadGeneration || closed) return { ok: false, error: "A newer link was opened." };
      linkHidden = true;
      syncHeaderHeight();
      resizeView();
      applyPinned();
      applyOpacity();
      clickThrough = true;
      pointerOverToolbar = true;
      applyClickThrough();
      refreshPointerPoll();
      if (shortcut) {
        hide();
        report("Viewer hidden · link bar removed · click-through on. Ctrl+Alt+V shows it · Ctrl+Alt+C toggles click-through.");
      } else {
        report("Viewer loaded · link bar removed · click-through on. Hover the toolbar to use controls.");
      }
      return { ok: true, linkHidden: true, clickThrough: true, headerHeight };
    } catch {
      if (generation === loadGeneration && !closed) report("Could not load the viewer. Check the link or click Reload to retry.");
      return { ok: false, error: "Could not load the viewer. Check the link or try again." };
    }
  }

  function trusted(event) {
    return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === homeUrl;
  }
  function handle(name, action) {
    ipcMain.handle(`viewer:${name}`, (event, ...args) => {
      if (!trusted(event)) throw new Error("This action is available only in the viewer toolbar.");
      return action(...args);
    });
  }
  handle("status", snapshot);
  handle("open", openViewer);
  handle("reload", () => viewerUrl ? openViewer(viewerUrl) : { ok: false, error: "Paste a viewer link first." });
  handle("hide", hide);
  handle("quit", () => win.close());
  handle("pin", setPinned);
  handle("opacity", delta => adjustOpacity(Number(delta) || 0));
  handle("clickThrough", setClickThrough);
  handle("pointer", setPointerOverToolbar);
  handle("linkBar", setLinkBarVisible);
  win.webContents.on("did-finish-load", () => report(message));
  win.once("ready-to-show", () => {
    if (options.showWindow !== false && !closed) win.show();
  });
  win.on("closed", () => {
    closed = true;
    loadGeneration++;
    stopPointerPoll();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    if (shortcut) globalShortcut.unregister(TOGGLE_SHORTCUT);
    if (pinShortcut) globalShortcut.unregister(PIN_SHORTCUT);
    if (opacityUpShortcut) globalShortcut.unregister(OPACITY_UP_SHORTCUT);
    if (opacityDownShortcut) globalShortcut.unregister(OPACITY_DOWN_SHORTCUT);
    if (clickThroughShortcut) globalShortcut.unregister(CLICK_THROUGH_SHORTCUT);
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
  });
  win.loadFile(homePath);
  return {
    window: win, snapshot, openViewer, hide, restore, setPinned, togglePinned,
    adjustOpacity, setClickThrough, toggleClickThrough, setPointerOverToolbar,
    setLinkBarVisible, getView: () => view, getOpacity: () => opacity,
    getHeaderHeight: () => headerHeight
  };
}

function start() {
  const electron = require("electron");
  const { app } = electron;
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let controller;
  app.on("second-instance", () => controller?.restore());
  app.whenReady().then(() => { controller = createViewer(electron); });
  app.on("window-all-closed", () => app.quit());
}

if (require.main === module) start();
module.exports = {
  createViewer, HEADER_HEIGHT, COMPACT_HEADER_HEIGHT, TOGGLE_SHORTCUT, PIN_SHORTCUT,
  OPACITY_UP_SHORTCUT, OPACITY_DOWN_SHORTCUT, CLICK_THROUGH_SHORTCUT,
  OPACITY_STEP, MIN_OPACITY, MAX_OPACITY
};
