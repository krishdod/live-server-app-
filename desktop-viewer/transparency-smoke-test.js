"use strict";
// Render only a local fixture offscreen; never capture the user's desktop.
const electron = require("electron");
const { app, BrowserWindow, WebContentsView } = electron;
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("../server/node_modules/ws");
const { createViewer } = require("./main");
const output = path.join(__dirname, "../artifacts/website-checks/glass");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "lw-glass-check-")));
fs.mkdirSync(output, { recursive: true });
let relay, sockets, viewer, finished = false;
const samples = [];
const timeout = setTimeout(() => finish(new Error("Transparency check timed out")), 30000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: !error, samples,
    ...(error ? { error: error.message, stack: error.stack } : {}) }, null, 2));
  if (viewer) viewer.window.close();
  if (sockets) { for (const client of sockets.clients) client.terminate(); sockets.close(); }
  if (relay) relay.close();
  app.exit(error ? 1 : 0);
}
function track(contents) {
  contents.on("paint", (_event, _rect, image) => { contents.lastPaint = image; });
  contents.setFrameRate(30);
}
async function painted(contents) {
  contents.invalidate();
  for (let i = 0; i < 40; i++) {
    await delay(50);
    if (contents.lastPaint && !contents.lastPaint.isEmpty()) return contents.lastPaint;
  }
  throw new Error("No offscreen pixels were painted");
}
function pixel(image, x, y) {
  const { width } = image.getSize();
  const rgba = image.toBitmap().subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
  return { r: rgba[2], g: rgba[1], b: rgba[0], a: rgba[3] };
}
async function sample(contents, name) {
  contents.lastPaint = null;
  const paintedImage = await painted(contents);
  // Chromium can mark a translucent offscreen image as opaque when encoding
  // PNGs. Rebuild its image metadata from the unchanged rendered pixel buffer.
  const image = electron.nativeImage.createFromBitmap(paintedImage.toBitmap(), paintedImage.getSize());
  fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
  const { width, height } = image.getSize();
  const value = pixel(image, Math.floor(width / 2), height - 40);
  samples.push({ name, width, height, pixel: value });
  return { value, image };
}
async function readable(contents, image, light) {
  const rect = await contents.executeJavaScript(`(() => {
    const r = document.querySelector('#answer strong').getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, viewport: innerWidth };
  })()`);
  const size = image.getSize();
  const scale = size.width / rect.viewport;
  const bitmap = image.toBitmap();
  let foreground = 0;
  for (let y = Math.max(0, Math.ceil(rect.y * scale)); y < Math.min(size.height, Math.floor(rect.bottom * scale)); y++) {
    for (let x = Math.max(0, Math.ceil(rect.x * scale)); x < Math.min(size.width, Math.floor(rect.right * scale)); x++) {
      const i = (y * size.width + x) * 4;
      if (bitmap[i + 3] >= 250 && (light ? bitmap[i + 2] < 80 : bitmap[i + 2] > 200)) foreground++;
    }
  }
  assert.ok(foreground > 40, "actual text pixels remain opaque and contrast with the surface");
}
function alpha(value, expected, label) {
  assert.ok(Math.abs(value.a - Math.round(expected * 255)) <= 1,
    `${label}: expected alpha ${expected}, got ${value.a}/255`);
}
async function preview(hostImage, pageImage) {
  const win = new BrowserWindow({ show: false, width: 1040, height: 820,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  track(win.webContents);
  const host = hostImage.toDataURL();
  const page = pageImage.toDataURL();
  const html = `<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;background:#edf1ec;color:#526057;font:15px/1.8 system-ui,sans-serif}
    .label{position:absolute;left:80px;top:18px;color:#526057;font-size:12px}.notes{margin:95px 120px;width:720px}.notes h1{font-size:32px;color:#35483a}
    .row{padding:20px 0;border-bottom:1px solid #ccd8cd}.app{position:absolute;left:80px;top:70px;width:880px;height:680px;border-radius:10px;overflow:hidden;box-shadow:0 20px 60px #15251a33}
    .host{position:absolute;inset:0;width:880px;height:680px;z-index:2;pointer-events:none}.page{position:absolute;left:0;top:44px;width:880px;height:680px}
    </style><div class="label">Rendered viewer · sample desktop background</div><section class="notes"><h1>Project notes</h1><p>A sample window behind the viewer, used only to demonstrate transparency.</p>
    <div class="row">Agenda &nbsp; &nbsp; &nbsp; Notes &nbsp; &nbsp; &nbsp; Follow-up</div><div class="row">Review the latest changes</div><div class="row">Prepare the next discussion</div><div class="row">Share notes with the team</div><div class="row">Keep the important details in view</div><div class="row">Next steps</div></section>
    <div class="app"><img class="page" src="${page}" alt="Rendered answer"><img class="host" src="${host}" alt="Rendered controls"></div>`;
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await win.webContents.executeJavaScript(`Promise.all(Array.from(document.images, image => image.decode()))`);
    win.webContents.lastPaint = null;
    const image = await painted(win.webContents);
    fs.writeFileSync(path.join(output, "desktop-preview.png"), image.toPNG());
  } finally { win.destroy(); }
}
app.whenReady().then(async () => {
  relay = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/auth") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ secured: false, ok: true, role: "view" }));
      return;
    }
    const files = { "/": "viewer.html", "/workspace.css": "workspace.css", "/markdown.js": "markdown.js",
      "/vendor/marked.umd.js": "vendor/marked.umd.js", "/vendor/purify.min.js": "vendor/purify.min.js" };
    if (!files[url.pathname]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": url.pathname === "/" ? "text/html" : url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    res.end(fs.readFileSync(path.join(__dirname, "../server", files[url.pathname])));
  });
  sockets = new WebSocketServer({ server: relay });
  sockets.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth", role: "view", clientId: "glass-check" }));
    socket.send(JSON.stringify({ type: "sync", from: "server", text: "## Clear text\n\n**This text must remain readable.**\n\n- A translucent background\n- A fully visible answer\n\n```js\nconst ready = true;\n```" }));
  });
  await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
  viewer = createViewer({ ...electron,
    BrowserWindow: function (options) {
      const win = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } });
      track(win.webContents);
      return win;
    },
    WebContentsView: function (options) {
      const view = new WebContentsView({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } });
      track(view.webContents);
      return view;
    }
  }, { showWindow: false, registerShortcut: false });
  await viewer.openViewer(`http://127.0.0.1:${relay.address().port}/?role=view&key=fixture`);
  const page = viewer.getView().webContents;
  for (let i = 0; i < 80; i++) {
    if (await page.executeJavaScript(`document.querySelector('#answer strong')?.textContent === 'This text must remain readable.'`)) break;
    await delay(50);
  }
  for (let i = 0; i < 40 && (!viewer.snapshot().hasAnswer || viewer.snapshot().connection !== 'connected'); i++) await delay(50);
  assert.equal(viewer.snapshot().connection, 'connected');
  assert.equal(await page.executeJavaScript(`document.documentElement.scrollHeight <= innerHeight`), true, 'a short answer does not create an unnecessary scrollbar');
  const host = await sample(viewer.window.webContents, "host");
  alpha(host.value, 0, "no opaque host canvas behind the live page");
  alpha(pixel(host.image, 400, 20), 1, "visible control strip");
  const dark = await sample(page, "dark");
  alpha(dark.value, 0.65, "dark background");
  await readable(page, dark.image, false);
  await preview(host.image, dark.image);
  await page.executeJavaScript(`document.body.classList.add('theme-light')`);
  const light = await sample(page, "light");
  alpha(light.value, 0.65, "light background");
  await readable(page, light.image, true);
  viewer.adjustOpacity(-0.25);
  await delay(150);
  alpha((await sample(page, "forty-percent")).value, 0.4, "user can see more through the background");
  viewer.adjustOpacity(0.6);
  await delay(150);
  alpha((await sample(page, "solid")).value, 1, "100% remains a solid option");
  viewer.adjustOpacity(-0.35);
  await page.executeJavaScript(`document.body.classList.remove('theme-light')`);
  viewer.window.setContentSize(720, 540);
  await delay(150);
  const resized = await sample(page, "resized");
  alpha(resized.value, 0.65, "resizing preserves translucency");
  await readable(page, resized.image, false);
  await sample(viewer.window.webContents, "host-resized");
  alpha(samples.at(-1).pixel, 0, "resizing does not restore an opaque host canvas");
  console.log(JSON.stringify({ renderedPixelChecks: samples }));
  assert.equal(viewer.window.getOpacity(), 1);
  assert.equal(viewer.window.isContentProtected(), true);
  finish();
}).catch(finish);
