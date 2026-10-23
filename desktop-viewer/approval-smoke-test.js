"use strict";
// End-to-end local check using the real server, request page, owner dashboard,
// and desktop renderer. Credentials below are deliberately test-only.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createViewer, TOOLBAR_SHORTCUT } = require("./main");

const output = path.join(__dirname, "../artifacts/approval-checks");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "lw-approval-smoke-")));
let server, ownerWindow, viewer;
let finished = false;
const captureNotes = [];
const deadline = setTimeout(() => finish(new Error("Approval integration check timed out")), 60000);

function finish(error, details = {}) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
    passed: !error, ...details, ...(error ? { error: error.message, stack: error.stack } : {})
  }, null, 2));
  if (viewer && !viewer.window.isDestroyed()) viewer.window.close();
  if (ownerWindow && !ownerWindow.isDestroyed()) ownerWindow.close();
  if (server) server.kill();
  app.exit(error ? 1 : 0);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 12000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function capture(contents, name) {
  try {
    await delay(150);
    const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    fs.writeFileSync(path.join(output, name), image.toPNG());
  } catch (error) {
    // A hidden protected renderer can have no capture surface. This does not
    // replace the actual DOM, stream, and authorization assertions below.
    captureNotes.push(`${name}: ${error.message}`);
  }
}

app.whenReady().then(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "../server/server.js")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: "0", RENDER: "",
      NODE_ENV: "test", APP_ORIGIN: "", VIEWER_APPROVAL_REQUIRED: "true",
      EDIT_KEY: "smoke-owner-only", VIEW_KEY: "smoke-old-view-key",
      STREAM_KEY: "smoke-stream-only", APP_PASSWORD: "smoke-password",
      SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" }
  });
  const port = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    server.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/Server running on port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    server.stderr.on("data", chunk => { errors += chunk; });
    server.once("error", reject);
    server.once("exit", code => reject(new Error(`Local server exited (${code}): ${errors}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/auth?role=view&key=smoke-old-view-key`)).status, 403,
    "old view key cannot bypass owner approval");

  // Simulate shortcuts; never reserve the user's keyboard shortcuts.
  const shortcuts = new Map();
  const taskbarStates = [];
  viewer = createViewer({ ...require("electron"), BrowserWindow: function (options) {
    const win = new BrowserWindow(options);
    const setSkipTaskbar = win.setSkipTaskbar.bind(win);
    win.setSkipTaskbar = value => { taskbarStates.push(value); setSkipTaskbar(value); };
    return win;
  }, globalShortcut: {
    register(key, callback) {
      if (![TOOLBAR_SHORTCUT, "Control+Alt+V"].includes(key)) return false;
      shortcuts.set(key, callback);
      return true;
    },
    unregister(key) { shortcuts.delete(key); }
  } }, { showWindow: false });
  let hideCalls = 0;
  const nativeHide = viewer.window.hide.bind(viewer.window);
  viewer.window.hide = () => { hideCalls++; nativeHide(); };
  const toolbar = viewer.window.webContents;
  await until(() => toolbar.executeJavaScript(`document.querySelector('#viewer-url')?.value === 'https://live-server-app.onrender.com/access'`), "default server link");
  async function verifyPanelLayout() {
    for (const width of [560, 880]) {
      viewer.window.setContentSize(width, 680);
      await delay(100);
      const fits = await toolbar.executeJavaScript(`Array.from(document.querySelectorAll('.toolbar button, .toolbar input, .toolbar label:not(.sr-only), #shortcut-hint, .viewer-strip button, .strip-heading'))
        .filter(el => el.getClientRects().length)
        .every(el => { const r = el.getBoundingClientRect(); const panel = document.body.classList.contains('toolbar-hidden') ? '.viewer-strip' : '.toolbar'; return r.left >= 0 && r.right <= innerWidth && r.bottom <= document.querySelector(panel).getBoundingClientRect().bottom; })`);
      assert.equal(fits, true, `controls fit at ${width}px`);
    }
  }
  await verifyPanelLayout();
  assert.equal((await viewer.openViewer(`${base}/access`)).ok, true);
  const page = viewer.getView().webContents;
  await until(() => page.executeJavaScript(`document.querySelector('#notice')?.textContent === 'Request access to continue.'`), "initial access check");
  assert.equal(viewer.snapshot().interactivePage, true);
  await page.executeJavaScript(`document.querySelector('#name').value = 'Local verification'; document.querySelector('#requestForm').requestSubmit();`);
  const code = await until(() => page.executeJavaScript(`document.querySelector('#requestCode')?.textContent`), "request code");
  assert.match(code, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(await page.executeJavaScript(`document.cookie.includes('lw')`), false,
    "approval cookie is not exposed to page scripts");
  await capture(page, "viewer_waiting.png");

  ownerWindow = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
      partition: "approval-smoke-owner", backgroundThrottling: false } });
  await ownerWindow.loadURL(`${base}/access-admin`);
  await ownerWindow.webContents.executeJavaScript(`
    document.querySelector('#ownerKey').value = 'smoke-owner-only';
    document.querySelector('#ownerPassword').value = 'smoke-password';
    document.querySelector('#ownerForm').requestSubmit();
  `);
  await until(() => ownerWindow.webContents.executeJavaScript(`document.querySelector('#requests')?.textContent.includes(${JSON.stringify(code)})`), "owner sees matching request");
  await ownerWindow.webContents.executeJavaScript(`document.querySelector('#requests button').click();`);
  await until(() => page.getTitle() === "Live Workspace — Ready", "approval opens viewer");
  await until(() => !viewer.snapshot().interactivePage, "desktop restores viewer controls");
  await until(() => toolbar.executeJavaScript(`getComputedStyle(document.querySelector('.toolbar')).display === 'none'`), "approved viewer hides setup panel");
  async function glassAlpha() {
    return page.executeJavaScript(`Number(getComputedStyle(document.body).backgroundColor.match(/[\\d.]+/g)?.[3] ?? 1)`);
  }
  await until(async () => await glassAlpha() === 0.75, "glass background applied to approved page");
  assert.equal(viewer.window.getOpacity(), 1, "native window opacity never fades text");
  assert.equal(await page.executeJavaScript(`getComputedStyle(document.documentElement).backgroundColor`), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.executeJavaScript(`getComputedStyle(document.querySelector('#answer')).opacity`), '1');
  assert.equal(await page.executeJavaScript(`getComputedStyle(document.querySelector('.workspace')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  await until(() => toolbar.executeJavaScript(`getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)'`), "host page is transparent behind live content");
  assert.equal(viewer.getHeaderHeight(), 44);
  assert.equal(viewer.getView().getBounds().y, 44);
  assert.equal(viewer.getView().getBounds().height, viewer.window.getContentSize()[1] - 44);
  assert.equal(hideCalls, 0, "approval never hides the native window, even with the hide shortcut available");
  assert.equal(taskbarStates.at(-1), false, "native taskbar visibility stays enabled");
  assert.equal(viewer.snapshot().clickThrough, false);
  await verifyPanelLayout();
  await toolbar.executeJavaScript(`document.querySelector('#show-controls').click()`);
  await until(() => toolbar.executeJavaScript(`getComputedStyle(document.querySelector('.toolbar')).display !== 'none' && document.querySelector('#open-form').hidden`), "controls shortcut restores compact panel");
  assert.equal(viewer.getView().getBounds().y, 128);
  await verifyPanelLayout();
  await toolbar.executeJavaScript(`document.querySelector('#opacity-down').click()`);
  await until(async () => await glassAlpha() === 0.7, "background changes independently of text");
  assert.equal(viewer.window.getOpacity(), 1);
  await page.executeJavaScript(`document.body.classList.add('theme-light')`);
  assert.equal(await glassAlpha(), 0.7, "light mode also keeps a translucent surface");
  await page.executeJavaScript(`document.body.classList.remove('theme-light')`);
  await toolbar.executeJavaScript(`document.querySelector('#hide-controls').click()`);
  await until(() => viewer.snapshot().toolbarHidden, "Done hides controls without reconnecting");
  await until(() => toolbar.executeJavaScript(`document.activeElement.id === 'show-controls'`), "keyboard focus returns to visible Controls button");

  const sent = await fetch(`${base}/answer`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "smoke-stream-only", text: "## Approval verified\n\n**Live answers still arrive.**\n\n- Formatting is preserved\n- Viewing requires owner approval" }) });
  assert.equal(sent.status, 204);
  await until(() => page.executeJavaScript(`document.querySelector('#answer h2')?.textContent === 'Approval verified'`), "formatted streamed answer");
  assert.equal(await page.executeJavaScript(`document.querySelectorAll('#answer li').length`), 2);
  assert.equal(await page.executeJavaScript(`document.querySelector('#answer strong')?.textContent`), "Live answers still arrive.");
  assert.equal(await page.executeJavaScript(`typeof require === 'undefined' && typeof process === 'undefined' && typeof viewerApi === 'undefined'`), true);
  await capture(page, "viewer_approved.png");
  await until(() => ownerWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#requests button')).some(b => b.textContent === 'Revoke access')`), "revoke control");
  await capture(ownerWindow.webContents, "owner_dashboard.png");

  // Refreshing the same renderer retains the HttpOnly approval session.
  page.reload();
  await until(() => page.executeJavaScript(`document.querySelector('#answer h2')?.textContent === 'Approval verified'`), "approved reconnect retains latest answer");
  await until(async () => await glassAlpha() === 0.7, "reconnect restores chosen glass opacity");
  await ownerWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#requests button')).find(b => b.textContent === 'Revoke access').click();`);
  await until(() => page.getURL().includes("/access"), "revocation closes viewer");
  await until(() => page.executeJavaScript(`document.querySelector('#notice')?.textContent.includes('ended your access')`), "revoked message");
  assert.equal(await page.executeJavaScript(`document.querySelector('#answer') === null`), true);
  assert.equal(viewer.snapshot().interactivePage, true);
  assert.equal(viewer.snapshot().toolbarHidden, false);
  assert.equal(viewer.window.getOpacity(), 1);
  assert.notEqual(await glassAlpha(), 0.7, "revoked access form is solid again");
  assert.equal(viewer.getView().getBounds().y, 128);
  await until(() => toolbar.executeJavaScript(`getComputedStyle(document.querySelector('.toolbar')).display !== 'none'`), "revocation restores controls");
  await capture(page, "viewer_revoked.png");
  assert.equal(viewer.window.isContentProtected(), true);
  assert.equal(viewer.window.isVisible(), false, "noninteractive test never opens a visible window");
  finish(null, { requested: true, ownerPasswordGate: true, approvedViaDashboard: true,
    liveFormattedAnswer: true, reconnectRetainsApproval: true, revokedViaDashboard: true,
    oldLinkDenied: true, rendererIsolated: true, nativeCaptureFlag: true,
    newDefaultUrl: true, approvedToolbarCollapsed: true, compactStripLayout: true,
    approvalDoesNotHideWindow: true, taskbarDiscoverable: true, clickThroughOptIn: true,
    controlsButtonRestoresPanel: true, keyboardFocusVisible: true, revocationRestoresPanel: true,
    narrowAndStandardPanelLayout: true,
    translucentSurface: true, foregroundFullyOpaque: true,
    independentBackgroundAdjustment: true, lightThemeGlass: true,
    reloadPreservesBackground: true, solidApprovalForms: true,
    receiverScreenShareVerified: false, captureNotes });
}).catch(error => finish(error));
