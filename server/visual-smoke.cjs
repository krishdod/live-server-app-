"use strict";
// Run with desktop-viewer/node_modules/.bin/electron.cmd server/visual-smoke.cjs.
// Real pages, real local approval flow, isolated test credentials, no visible windows.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const output = path.join(__dirname, "../artifacts/website-checks");
const windows = [];
const checks = [];
let relay, finished = false;
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "lw-website-check-")));
const deadline = setTimeout(() => finish(new Error("Website checks timed out")), 60000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: !error, checks,
    ...(error ? { error: error.message, stack: error.stack } : {}) }, null, 2));
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  if (relay) relay.kill();
  app.exit(error ? 1 : 0);
}
async function until(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function browser() {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, partition: `visual-${windows.length}-${Date.now()}` } });
  win.webContents.on("paint", (_event, _rect, image) => { win.lastPaint = image; });
  win.webContents.setFrameRate(30);
  windows.push(win);
  return win;
}
async function snapshot(win, filename) {
  win.webContents.invalidate();
  await delay(250);
  const image = win.lastPaint;
  assert.ok(image && !image.isEmpty(), "offscreen browser rendered a screenshot");
  fs.writeFileSync(path.join(output, filename), image.toPNG());
}
async function layout(win, name) {
  for (const width of [375, 768, 1280]) {
    win.setContentSize(width, 900);
    await delay(120);
    const result = await win.webContents.executeJavaScript(`({
      fits: document.documentElement.scrollWidth <= innerWidth,
      controlsFit: Array.from(document.querySelectorAll('button,input,select')).filter(el => el.getClientRects().length)
        .every(el => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; })
    })`);
    assert.equal(result.fits, true, `${name} has no page overflow at ${width}px`);
    assert.equal(result.controlsFit, true, `${name} controls fit at ${width}px`);
  }
  checks.push(`${name}: 375/768/1280px layout`);
}

app.whenReady().then(async () => {
  relay = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: "0", RENDER: "", NODE_ENV: "development",
      APP_ORIGIN: "", EDIT_KEY: "visual-owner-test-only", STREAM_KEY: "visual-stream-test-only",
      VIEW_KEY: "visual-legacy-test-only", APP_PASSWORD: "", VIEWER_APPROVAL_REQUIRED: "true",
      SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" }, stdio: ["ignore", "pipe", "pipe"]
  });
  const port = await new Promise((resolve, reject) => {
    let text = "", errors = "";
    relay.stdout.on("data", chunk => { text += chunk; const match = text.match(/Server running on port (\d+)/); if (match) resolve(match[1]); });
    relay.stderr.on("data", chunk => { errors += chunk; });
    relay.once("error", reject);
    relay.once("exit", code => reject(new Error(`Relay exited: ${code} ${errors}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/workspace.css`)).status, 200);
  const viewer = browser();
  await viewer.loadURL(`${base}/access`);
  await until(() => viewer.webContents.executeJavaScript(`document.querySelector('#notice').textContent === 'Request access to continue.'`), "access ready");
  await layout(viewer, "access page");
  await snapshot(viewer, "access_desktop.png");
  viewer.setContentSize(375, 900);
  await snapshot(viewer, "access_mobile.png");
  viewer.setContentSize(1280, 900);
  await viewer.webContents.executeJavaScript(`document.querySelector('#name').value = 'Jordan Williams'; document.querySelector('#requestForm').requestSubmit()`);
  await until(() => viewer.webContents.executeJavaScript(`!!document.querySelector('#requestCode').textContent`), "request code");
  const code = await viewer.webContents.executeJavaScript(`document.querySelector('#requestCode').textContent`);
  await snapshot(viewer, "request_pending.png");
  const second = browser();
  await second.loadURL(`${base}/access`);
  await until(() => second.webContents.executeJavaScript(`document.querySelector('#notice').textContent === 'Request access to continue.'`), "second viewer ready");
  await second.webContents.executeJavaScript(`document.querySelector('#name').value = 'Morgan Chen'; document.querySelector('#requestForm').requestSubmit()`);
  await until(() => second.webContents.executeJavaScript(`!!document.querySelector('#requestCode').textContent`), "second code");
  const owner = browser();
  await owner.loadURL(`${base}/access-admin`);
  await until(() => owner.webContents.executeJavaScript(`!document.querySelector('#ownerForm').hidden`), "owner login");
  await layout(owner, "owner sign-in");
  await owner.webContents.executeJavaScript(`document.querySelector('#ownerKey').value = 'visual-owner-test-only'; document.querySelector('#ownerForm').requestSubmit()`);
  await until(() => owner.webContents.executeJavaScript(`document.querySelector('#pendingCount').textContent === '2'`), "real request counts");
  await owner.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.request-row')).find(row => row.textContent.includes(${JSON.stringify(code)})).querySelector('button').click()`);
  await until(() => viewer.webContents.getTitle() === "Live Workspace — Ready", "approval opens viewer");
  await until(() => owner.webContents.executeJavaScript(`document.querySelector('#approvedCount').textContent === '1'`), "approved count");
  await layout(owner, "owner dashboard");
  await snapshot(owner, "owner_dashboard.png");
  owner.setContentSize(375, 900);
  await snapshot(owner, "owner_mobile.png");
  const answer = '## Release checklist\n\nThe workspace is ready for the next review. Here is what changed and what to check before sharing.\n\n### What is ready\n\n- Viewer requests are approved by the owner.\n- Live answers keep their formatting as they arrive.\n- Access can be revoked at any time.\n\n### A small implementation detail\n\n```javascript\nconst session = { role: "viewer", expiresIn: 3600 };\nconsole.log(session.role);\n```\n\nShare the request code directly with the person who owns the workspace.';
  const sent = await fetch(`${base}/answer`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "visual-stream-test-only", text: answer }) });
  assert.equal(sent.status, 204);
  await until(() => viewer.webContents.executeJavaScript(`document.querySelector('#answer h2')?.textContent === 'Release checklist'`), "formatted live answer");
  await layout(viewer, "live workspace");
  await snapshot(viewer, "workspace_dark.png");
  viewer.setContentSize(375, 900);
  await snapshot(viewer, "workspace_mobile.png");
  viewer.setContentSize(1280, 900);
  await viewer.webContents.executeJavaScript(`document.querySelector('#themeBtn').click()`);
  await snapshot(viewer, "workspace_light.png");
  await viewer.webContents.executeJavaScript(`document.querySelector('#focusBtn').click()`);
  assert.equal(await viewer.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.header')).display`), "none");
  checks.push("real request → approve → stream; live dashboard counts; light theme; focus mode");
  finish();
}).catch(finish);
