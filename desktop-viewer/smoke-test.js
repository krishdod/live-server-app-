"use strict";
// Noninteractive integration check: only an ephemeral local fixture is loaded.
const electron = require('electron');
const { app } = electron;
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('../server/node_modules/ws');
const { createViewer } = require('./main');
let server, wss, controller;
const resultPath = path.join(__dirname, 'smoke-result.json');
const timer = setTimeout(() => finish(new Error('Integration check timed out')), 25000);
function finish(error, details = {}) {
  clearTimeout(timer);
  fs.writeFileSync(resultPath, JSON.stringify({ passed: !error, ...details, ...(error ? { error: error.message } : {}) }, null, 2));
  if (controller) controller.window.close();
  if (wss) { for (const client of wss.clients) client.terminate(); wss.close(); }
  if (server) server.close();
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/auth') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ secured: false, ok: true, role: 'view' }));
      return;
    }
    const files = { '/': 'viewer.html', '/markdown.js': 'markdown.js',
      '/vendor/marked.umd.js': 'vendor/marked.umd.js', '/vendor/purify.min.js': 'vendor/purify.min.js' };
    if (!files[url.pathname]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': url.pathname === '/' ? 'text/html' : 'text/javascript' });
    res.end(fs.readFileSync(path.join(__dirname, '../server', files[url.pathname])));
  });
  wss = new WebSocketServer({ server });
  wss.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'auth', role: 'view', clientId: 'desktop-smoke' }));
    socket.send(JSON.stringify({ type: 'autoCopy', on: true }));
    socket.send(JSON.stringify({ type: 'sync', from: 'server', text: '## Viewer test\n\n**Streaming works.**\n\n- First item\n- Second item' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  controller = createViewer(electron, { showWindow: false, registerShortcut: false });
  assert.equal(controller.snapshot().protection, true);
  const result = await controller.openViewer(`http://127.0.0.1:${server.address().port}/?role=view&key=local-test-only`);
  assert.equal(result.ok, true);
  const wc = controller.getView().webContents;
  let visible;
  for (let attempt = 0; attempt < 30; attempt++) {
    visible = await wc.executeJavaScript(`({
      heading: document.querySelector('#answer h2')?.textContent,
      bold: document.querySelector('#answer strong')?.textContent,
      listItems: document.querySelectorAll('#answer li').length,
      noNode: typeof require === 'undefined' && typeof process === 'undefined',
      noToolbarApi: typeof window.viewerApi === 'undefined'
    })`);
    if (visible.heading) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(visible.heading, 'Viewer test');
  assert.equal(visible.bold, 'Streaming works.');
  assert.equal(visible.listItems, 2);
  assert.equal(visible.noNode, true);
  assert.equal(visible.noToolbarApi, true);
  assert.equal(controller.window.isVisible(), false);
  finish(null, { nativeCaptureFlag: controller.window.isContentProtected(), liveViewer: visible,
    receiverScreenShareVerified: false });
}).catch(error => finish(error));
