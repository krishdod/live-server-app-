"use strict";
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { normalizeViewerUrl, allowedNavigation, isReadyViewer, supportsCaptureExclusion } = require("./policy");
const { createAppearance, DEFAULT_BACKGROUND_OPACITY } = require("./appearance");

const HEADER_HEIGHT = 176;
const COMPACT_HEADER_HEIGHT = 128;
const COLLAPSED_HEADER_HEIGHT = 44;
const TOGGLE_SHORTCUT = "Control+Alt+V";
const PIN_SHORTCUT = "Control+Alt+T";
const OPACITY_UP_SHORTCUT = "Control+Alt+=";
const OPACITY_DOWN_SHORTCUT = "Control+Alt+-";
const CLICK_THROUGH_SHORTCUT = "Control+Alt+C";
const TOOLBAR_SHORTCUT = "Control+Alt+B";
const OPACITY_STEP = 0.05;
const MIN_OPACITY = 0.2;
const MAX_OPACITY = 1;
const CHANNELS = ["status", "open", "reload", "hide", "quit", "pin", "opacity", "clickThrough", "pointer", "linkBar", "toolbar"]
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
  let toolbarShortcut = false;
  let pinned = true;
  let opacity = DEFAULT_BACKGROUND_OPACITY;
  let clickThrough = false;
  let interactivePage = true;
  let pointerOverToolbar = true;
  let linkHidden = false;
  let toolbarHidden = false;
  let headerHeight = HEADER_HEIGHT;
  let pointerPoll = null;
  let view = null;
  let viewerUrl = "";
  let loadGeneration = 0;
  let closed = false;
  let message = "Open the access page to request approval. The window stays visible while you wait.";

  const win = new BrowserWindow({
    title: "Live Workspace Viewer", width: 880, height: 680,
    minWidth: 560, minHeight: 410, show: false, alwaysOnTop: true,
    skipTaskbar: false, backgroundColor: "#10151d", autoHideMenuBar: true,
    transparent: true, frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, devTools: false
    }
  });
  win.setMenu(null);
  const appearance = createAppearance(win, options.platform ?? process.platform, options.release ?? os.release());

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
    appearance.apply(view, interactivePage, opacity);
  }
  function applyClickThrough() {
    if (closed) return;
    const ignore = !interactivePage && clickThrough && !pointerOverToolbar;
    try { win.setIgnoreMouseEvents(ignore, { forward: true }); }
    catch {
      try { win.setIgnoreMouseEvents(ignore); } catch { /* harness / unsupported */ }
    }
  }
  function syncHeaderHeight() {
    headerHeight = toolbarHidden ? COLLAPSED_HEADER_HEIGHT : linkHidden ? COMPACT_HEADER_HEIGHT : HEADER_HEIGHT;
  }
  function stopPointerPoll() {
    if (pointerPoll) {
      clearInterval(pointerPoll);
      pointerPoll = null;
    }
  }
  function refreshPointerPoll() {
    stopPointerPoll();
    if (interactivePage || !clickThrough || closed || !screen || typeof screen.getCursorScreenPoint !== "function") return;
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
      opacityUpShortcut, opacityDownShortcut, clickThroughShortcut, toolbarShortcut,
      pinned, opacity: interactivePage ? 1 : opacity,
      clickThrough: !interactivePage && clickThrough, interactivePage, linkHidden, toolbarHidden, headerHeight, message
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
      showInteractivePage("Capture protection could not be restored. Reopen the app before connecting.");
    }
    win.setSkipTaskbar(false);
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
    if (interactivePage) {
      report("Background controls are available after the live viewer opens.");
      return snapshot();
    }
    const next = Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round((opacity + delta) * 100) / 100));
    opacity = next;
    applyOpacity();
    report(`Background ${Math.round(opacity * 100)}% — text stays fully clear.`);
    return snapshot();
  }
  function setClickThrough(value) {
    if (interactivePage) {
      report("Click-through pauses while approval or sign-in needs your attention.");
      return snapshot();
    }
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
    if (visible === true) toolbarHidden = false;
    syncHeaderHeight();
    resizeView();
    if (!closed && !win.webContents.isDestroyed()) win.webContents.send("viewer:status-changed", snapshot());
    return snapshot();
  }
  function setToolbarVisible(visible) {
    // The collapsed strip keeps Controls reachable even without a shortcut.
    toolbarHidden = visible !== true && !interactivePage;
    pointerOverToolbar = true;
    syncHeaderHeight();
    resizeView();
    applyClickThrough();
    report(toolbarHidden ? "Viewer ready. Choose Controls to adjust your window." : "Controls shown. Choose Done to return to the viewer.");
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
    try {
      toolbarShortcut = globalShortcut.register(TOOLBAR_SHORTCUT, () => {
        setToolbarVisible(toolbarHidden);
        if (!toolbarHidden && options.showWindow !== false) {
          restore();
          win.webContents.focus();
        }
      });
    } catch { toolbarShortcut = false; }
  }
  // Keep the app discoverable; hiding is always an explicit user action.
  win.setSkipTaskbar(false);
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

  function showInteractivePage(text) {
    interactivePage = true;
    toolbarHidden = false;
    syncHeaderHeight();
    resizeView();
    pointerOverToolbar = true;
    applyOpacity();
    applyClickThrough();
    refreshPointerPoll();
    // A revoked/expired session must not leave a hidden or unclickable gate.
    if (options.showWindow !== false && !closed) {
      if (win.isMinimized()) win.restore();
      win.show();
    }
    report(text || "Complete approval or sign-in below. This page stays visible and clickable.");
  }

  function activateReadyViewer() {
    if (!interactivePage) { applyOpacity(); return; }
    interactivePage = false;
    linkHidden = true;
    toolbarHidden = true;
    syncHeaderHeight();
    resizeView();
    applyPinned();
    applyOpacity();
    pointerOverToolbar = true;
    applyClickThrough();
    refreshPointerPoll();
    if (options.showWindow !== false && !closed) {
      if (win.isMinimized()) win.restore();
      win.show();
    }
    report("Access approved. Your live viewer is open. Choose Controls for window settings.");
  }

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
      showInteractivePage("Capture protection is unavailable. The live page was not opened.");
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
    const isCurrent = () => generation === loadGeneration && !closed && view === nextView;
    const syncPageMode = title => {
      if (!isCurrent()) return;
      if (isReadyViewer(wc.getURL(), next, title)) activateReadyViewer();
      else showInteractivePage();
    };
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
    wc.on("did-start-navigation", (event, url, isInPlace, isMainFrame) => {
      const mainFrame = event.isMainFrame ?? isMainFrame;
      const sameDocument = event.isSameDocument ?? event.isInPlace ?? isInPlace;
      if (isCurrent() && mainFrame && !sameDocument) showInteractivePage("Connecting… approval and sign-in pages stay visible.");
    });
    wc.on("page-title-updated", (_event, title) => syncPageMode(title));
    wc.on("did-finish-load", () => syncPageMode(wc.getTitle()));
    wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) syncPageMode(wc.getTitle());
    });
    wc.on("will-attach-webview", event => event.preventDefault());
    wc.on("render-process-gone", () => {
      if (isCurrent()) showInteractivePage("The viewer stopped responding. Click Reload to reconnect.");
    });
    win.contentView.addChildView(nextView);
    resizeView();
    showInteractivePage("Connecting… a sleeping server can take up to a minute.");
    try {
      await wc.loadURL(next);
      if (generation !== loadGeneration || closed) return { ok: false, error: "A newer link was opened." };
      syncPageMode(wc.getTitle());
      return { ok: true, ...snapshot() };
    } catch {
      if (generation === loadGeneration && !closed) showInteractivePage("Could not load the viewer. Check the link or click Reload to retry.");
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
  handle("toolbar", setToolbarVisible);
  win.webContents.on("did-finish-load", () => report(message));
  win.once("ready-to-show", () => {
    if (options.showWindow !== false && !closed) win.show();
  });
  win.on("closed", () => {
    closed = true;
    loadGeneration++;
    stopPointerPoll();
    appearance.dispose();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    if (shortcut) globalShortcut.unregister(TOGGLE_SHORTCUT);
    if (pinShortcut) globalShortcut.unregister(PIN_SHORTCUT);
    if (opacityUpShortcut) globalShortcut.unregister(OPACITY_UP_SHORTCUT);
    if (opacityDownShortcut) globalShortcut.unregister(OPACITY_DOWN_SHORTCUT);
    if (clickThroughShortcut) globalShortcut.unregister(CLICK_THROUGH_SHORTCUT);
    if (toolbarShortcut) globalShortcut.unregister(TOOLBAR_SHORTCUT);
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
  });
  win.loadFile(homePath);
  return {
    window: win, snapshot, openViewer, hide, restore, setPinned, togglePinned,
    adjustOpacity, setClickThrough, toggleClickThrough, setPointerOverToolbar,
    setLinkBarVisible, setToolbarVisible, getView: () => view, getOpacity: () => opacity,
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
  createViewer, HEADER_HEIGHT, COMPACT_HEADER_HEIGHT, COLLAPSED_HEADER_HEIGHT, TOGGLE_SHORTCUT, PIN_SHORTCUT,
  OPACITY_UP_SHORTCUT, OPACITY_DOWN_SHORTCUT, CLICK_THROUGH_SHORTCUT, TOOLBAR_SHORTCUT,
  OPACITY_STEP, MIN_OPACITY, MAX_OPACITY
};
