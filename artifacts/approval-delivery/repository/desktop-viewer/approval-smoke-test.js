"use strict";
// End-to-end local check using the real server, request page, owner dashboard,
// and desktop renderer. Credentials below are deliberately test-only.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createViewer } = require("./main");

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

  viewer = createViewer(require("electron"), { showWindow: false, registerShortcut: false });
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
  await ownerWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#requests button')).find(b => b.textContent === 'Revoke access').click();`);
  await until(() => page.getURL().includes("/access"), "revocation closes viewer");
  await until(() => page.executeJavaScript(`document.querySelector('#notice')?.textContent.includes('ended your access')`), "revoked message");
  assert.equal(await page.executeJavaScript(`document.querySelector('#answer') === null`), true);
  assert.equal(viewer.snapshot().interactivePage, true);
  await capture(page, "viewer_revoked.png");
  assert.equal(viewer.window.isContentProtected(), true);
  assert.equal(viewer.window.isVisible(), false, "noninteractive test never opens a visible window");
  finish(null, { requested: true, ownerPasswordGate: true, approvedViaDashboard: true,
    liveFormattedAnswer: true, reconnectRetainsApproval: true, revokedViaDashboard: true,
    oldLinkDenied: true, rendererIsolated: true, nativeCaptureFlag: true,
    receiverScreenShareVerified: false, captureNotes });
}).catch(error => finish(error));
