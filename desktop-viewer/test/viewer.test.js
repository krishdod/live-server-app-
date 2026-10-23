const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { normalizeViewerUrl, allowedNavigation, isReadyViewer, supportsCaptureExclusion } = require('../policy');
const { createViewer } = require('../main');

function harness({ protection = true, shortcut = true, toolbarShortcut = shortcut, platform = 'win32', release = '10.0.26100' } = {}) {
  const events = [], handlers = new Map();
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: '' }; this.dead = false; this.styles = new Map(); this.styleCount = 0; }
    async insertCSS(css) { const key = String(++this.styleCount); this.styles.set(key, css); return key; }
    async removeInsertedCSS(key) { this.styles.delete(key); }
    setWindowOpenHandler(fn) { this.popup = fn; }
    async loadURL(url) {
      this.navigate(url);
      if (new URL(url).pathname === '/' && new URL(url).searchParams.get('role') === 'view') {
        this.setPageTitle('Live Workspace — Ready');
      }
      this.emit('did-finish-load');
    }
    navigate(url) {
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
      this.title = 'Live Workspace — Access required';
      this.url = url;
      this.mainFrame.url = url;
      events.push(['load', url]);
    }
    setPageTitle(title) { this.title = title; this.emit('page-title-updated', {}, title, true); }
    getTitle() { return this.title || ''; }
    getURL() { return this.url || ''; }
    send() {}
    focus() {}
    isDestroyed() { return this.dead; }
    close() { this.dead = true; }
  }
  class Win extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new Contents();
      this.visible = false; this.children = [];
      this.contentView = { addChildView: v => this.children.push(v), removeChildView: v => this.children.splice(this.children.indexOf(v), 1),
        setBackgroundColor: value => { this.rootBackground = value; } };
    }
    setMenu() {}
    setContentProtection(on) { events.push(['protect', on]); }
    isContentProtected() { return protection; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    setAlwaysOnTop(value) { this.pinned = value; }
    setOpacity(value) { this.opacity = value; }
    setBackgroundColor(value) { this.backgroundColor = value; }
    setBackgroundMaterial(value) { this.material = value; events.push(['material', value]); }
    setIgnoreMouseEvents(ignore, options) {
      this.ignoreMouse = ignore;
      this.ignoreMouseOptions = options || null;
      events.push(['ignore-mouse', ignore, options || null]);
    }
    getContentSize() { return [880, 680]; }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    restore() {}
    show() { events.push(['show']); this.visible = true; }
    focus() {}
    hide() { this.visible = false; }
    close() { this.emit('closed'); }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); }
    setBounds(bounds) { this.bounds = bounds; }
    setBackgroundColor(value) { this.backgroundColor = value; }
  }
  const ses = new EventEmitter();
  ses.setPermissionRequestHandler = fn => { ses.requestPermission = fn; };
  ses.setPermissionCheckHandler = fn => { ses.checkPermission = fn; };
  const shortcuts = {
    handlers: new Map(),
    register(key, fn) {
      shortcuts.handlers.set(key, fn);
      if (key === 'Control+Alt+V') shortcuts.toggle = fn;
      if (key === 'Control+Alt+T') shortcuts.pin = fn;
      if (key === 'Control+Alt+=') shortcuts.opacityUp = fn;
      if (key === 'Control+Alt+-') shortcuts.opacityDown = fn;
      if (key === 'Control+Alt+C') shortcuts.clickThrough = fn;
      if (key === 'Control+Alt+B') {
        shortcuts.toolbar = fn;
        return toolbarShortcut;
      }
      return shortcut;
    },
    unregister(key) { shortcuts.handlers.delete(key); }
  };
  const controller = createViewer({ app: {}, BrowserWindow: Win, WebContentsView: View, globalShortcut: shortcuts,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    session: { fromPartition: () => ses }
  }, { platform, release });
  return { ...controller, events, ses, handlers, shortcuts };
}

test('viewer links preserve access query and hash without imposing an editor role', () => {
  const link = 'https://example.com/?role=view&key=test%2Bsecret#answer';
  assert.equal(normalizeViewerUrl(link), link);
  assert.equal(normalizeViewerUrl('http://localhost:8765/'), 'http://localhost:8765/');
});

test('unsafe or mistaken URLs are rejected', () => {
  for (const url of ['file:///c:/secret', 'javascript:alert(1)', 'data:text/html,hello',
    'http://remote.example/', 'https://user:password@example.com/', 'https://github.com/krishdod/live-stream.git']) {
    assert.throws(() => normalizeViewerUrl(url));
  }
});

test('only same-origin secure navigations remain inside the viewer', () => {
  const base = 'https://example.com/?role=view&key=test';
  assert.equal(allowedNavigation('https://example.com/login', base), true);
  for (const target of ['https://example.com.evil.test/', 'https://elsewhere.com/', 'file:///c:/foo', 'http://example.com/']) {
    assert.equal(allowedNavigation(target, base), false);
  }
});

test('only a ready viewer at the expected same-origin path can enter overlay mode', () => {
  const base = 'https://example.com/access';
  const title = 'Live Workspace — Ready';
  assert.equal(isReadyViewer('https://example.com/?role=view', base, title), true);
  assert.equal(isReadyViewer('https://example.com/?role=view&overlay=1', base, title), true);
  for (const url of ['https://example.com/access', 'https://example.com/access-admin',
    'https://example.com/?role=edit', 'https://example.com/login?role=view', 'https://other.example/?role=view']) {
    assert.equal(isReadyViewer(url, base, title), false);
  }
  assert.equal(isReadyViewer('https://example.com/?role=view', base, 'Live Workspace — Access required'), false);
});

test('exclusion requires a supported Windows or macOS host', () => {
  assert.equal(supportsCaptureExclusion('win32', '10.0.19041'), true);
  assert.equal(supportsCaptureExclusion('win32', '10.0.26100'), true);
  assert.equal(supportsCaptureExclusion('win32', '10.0.18363'), false);
  assert.equal(supportsCaptureExclusion('darwin', '24.0.0'), true);
  assert.equal(supportsCaptureExclusion('darwin', '13.0.0'), true);
  assert.equal(supportsCaptureExclusion('linux', '6.8.0'), false);
});

test('macOS harness can open a viewer with capture exclusion', async () => {
  const c = harness({ platform: 'darwin', release: '24.0.0' });
  assert.equal(c.snapshot().supported, true);
  assert.equal((await c.openViewer('https://example.com/?role=view&key=mac')).ok, true);
  assert.equal(c.snapshot().linkHidden, true);
});

test('protection is requested before showing or loading remote content', async () => {
  const c = harness();
  assert.equal(c.window.options.show, false);
  assert.equal(c.events.some(e => e[0] === 'load'), false);
  c.window.emit('ready-to-show');
  assert.ok(c.events.findIndex(e => e[0] === 'protect') < c.events.findIndex(e => e[0] === 'show'));
  assert.equal((await c.openViewer('https://example.com/?role=view&key=test')).ok, true);
  assert.equal(c.getView().options.webPreferences.sandbox, true);
  assert.equal(c.getView().options.webPreferences.nodeIntegration, false);
  assert.equal(c.getView().options.webPreferences.preload, undefined);
});

test('failed protection never loads the live page', async () => {
  const c = harness({ protection: false });
  assert.equal((await c.openViewer('https://example.com/')).ok, false);
  assert.equal(c.getView(), null);
  assert.equal(c.window.skipTaskbar, false);
});

test('losing protection on reload removes existing content and loads nothing further', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view&key=first');
  const old = c.getView().webContents;
  c.window.isContentProtected = () => false;
  assert.equal((await c.openViewer('https://example.com/?role=view&key=second')).ok, false);
  assert.equal(c.getView(), null);
  assert.equal(old.isDestroyed(), true);
  assert.equal(c.events.filter(e => e[0] === 'load').length, 1);
});

test('toolbar IPC cannot be called by a remote page or subframe', async () => {
  const c = harness();
  const call = c.handlers.get('viewer:open');
  assert.throws(() => call({ sender: {}, senderFrame: {} }, 'https://example.com/'));
  assert.throws(() => call({ sender: c.window.webContents, senderFrame: { url: c.window.webContents.mainFrame.url } }, 'https://example.com/'));
  const result = await call({ sender: c.window.webContents, senderFrame: c.window.webContents.mainFrame }, 'https://example.com/');
  assert.equal(result.ok, true);
});

test('remote page cannot open an unprotected popup or leave its origin', async () => {
  const c = harness();
  await c.openViewer('https://example.com/');
  const wc = c.getView().webContents;
  assert.deepEqual(wc.popup({ url: 'https://another.example/' }), { action: 'deny' });
  let prevented = false;
  wc.emit('will-redirect', { preventDefault() { prevented = true; } }, 'https://another.example/');
  assert.equal(prevented, true);
});

test('camera, microphone and downloads are denied', () => {
  const c = harness();
  let permitted;
  c.ses.requestPermission({}, 'media', result => { permitted = result; });
  assert.equal(permitted, false);
  assert.equal(c.ses.checkPermission(), false);
  let prevented = false;
  c.ses.emit('will-download', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('only the current viewer origin may write plain clipboard content; reads stay denied', async () => {
  const c = harness();
  await c.openViewer('https://example.com/');
  const wc = c.getView().webContents;
  assert.equal(c.ses.checkPermission(wc, 'clipboard-sanitized-write', 'https://example.com'), true);
  assert.equal(c.ses.checkPermission(wc, 'clipboard-sanitized-write', 'https://another.example'), false);
  assert.equal(c.ses.checkPermission(wc, 'clipboard-read', 'https://example.com'), false);
  assert.equal(c.ses.checkPermission({}, 'clipboard-sanitized-write', 'https://example.com'), false);
});

test('hide shortcut remains registered while hidden and second invocation restores', () => {
  const c = harness();
  c.window.emit('ready-to-show');
  assert.equal(c.window.skipTaskbar, false);
  c.shortcuts.toggle();
  assert.equal(c.window.visible, false);
  c.shortcuts.toggle();
  assert.equal(c.window.visible, true);
});

test('approval keeps the viewer visible and clickable while removing its taskbar icon', async () => {
  const c = harness();
  c.window.emit('ready-to-show');
  assert.equal(c.window.visible, true);
  const opened = await c.openViewer('https://example.com/?role=view&key=test');
  assert.equal(opened.ok, true);
  assert.equal(opened.linkHidden, true);
  assert.equal(c.snapshot().linkHidden, true);
  assert.equal(c.snapshot().toolbarHidden, true);
  assert.equal(c.getHeaderHeight(), 44);
  assert.deepEqual(c.getView().bounds, { x: 0, y: 44, width: 880, height: 636 });
  assert.equal(c.snapshot().clickThrough, false);
  assert.equal(c.window.ignoreMouse, false);
  assert.equal(c.window.skipTaskbar, true);
  assert.equal(c.snapshot().iconHidden, true);
  assert.match(c.snapshot().message, /approved/i);
  assert.equal(c.window.visible, true);
});

test('the taskbar preference survives restoring the window and revocation shows the icon', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view');
  c.restore();
  assert.equal(c.window.skipTaskbar, true, 'restoring the window does not restore a hidden icon');
  c.setIconVisible(true);
  assert.equal(c.window.skipTaskbar, false);
  c.restore();
  assert.equal(c.window.skipTaskbar, false);
  c.setIconVisible(false);
  const wc = c.getView().webContents;
  wc.setPageTitle('Live Workspace — Access required');
  assert.equal(c.window.skipTaskbar, false, 'revocation makes the approval screen discoverable');
  wc.setPageTitle('Live Workspace — Ready');
  assert.equal(c.window.skipTaskbar, true, 'reapproval restores the chosen icon preference');
  assert.equal(c.window.visible, true);
});

test('the icon setting is available only to the trusted local toolbar', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view');
  const call = c.handlers.get('viewer:icon');
  assert.throws(() => call({ sender: {}, senderFrame: {} }, true));
  call({ sender: c.window.webContents, senderFrame: c.window.webContents.mainFrame }, true);
  assert.equal(c.window.skipTaskbar, false);
});

test('click-through passes mouse to apps behind unless the pointer is over the toolbar', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view&key=test');
  assert.equal(c.snapshot().clickThrough, false);
  c.shortcuts.clickThrough();
  assert.equal(c.snapshot().clickThrough, true);
  c.setPointerOverToolbar(true);
  assert.equal(c.window.ignoreMouse, false, 'collapsed strip stays clickable');
  c.shortcuts.toolbar();
  c.setPointerOverToolbar(false);
  assert.equal(c.window.ignoreMouse, true);
  assert.deepEqual(c.window.ignoreMouseOptions, { forward: true });
  c.setPointerOverToolbar(true);
  assert.equal(c.window.ignoreMouse, false);
  c.shortcuts.clickThrough();
  assert.equal(c.snapshot().clickThrough, false);
  assert.equal(c.window.ignoreMouse, false);
});

test('controls shortcut restores the panel and can hide it again without reconnecting', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view');
  const view = c.getView();
  c.shortcuts.toolbar();
  assert.equal(c.window.visible, true);
  assert.equal(c.snapshot().toolbarHidden, false);
  assert.equal(c.getHeaderHeight(), 128);
  assert.equal(view.bounds.y, 128);
  assert.equal(c.window.ignoreMouse, false);
  c.setLinkBarVisible(true);
  assert.equal(view.bounds.y, 176);
  c.shortcuts.toolbar();
  assert.equal(c.snapshot().toolbarHidden, true);
  assert.equal(view.bounds.y, 44);
  assert.equal(view.bounds.height, 636);
  assert.equal(c.getView(), view, 'toggling controls preserves the approved renderer');
  assert.equal(c.events.filter(e => e[0] === 'load').length, 1);
});

test('controls stay recoverable when the controls shortcut cannot register', async () => {
  const c = harness({ toolbarShortcut: false });
  await c.openViewer('https://example.com/?role=view');
  assert.equal(c.snapshot().toolbarShortcut, false);
  assert.equal(c.snapshot().toolbarHidden, true);
  assert.equal(c.getHeaderHeight(), 44);
  c.setToolbarVisible(true);
  assert.equal(c.snapshot().toolbarHidden, false, 'visible Controls button can still expand settings');
  c.setToolbarVisible(false);
  assert.equal(c.snapshot().toolbarHidden, true);
});

test('always on top pin shortcut toggles the pinned state', () => {
  const c = harness();
  assert.equal(c.snapshot().pinned, true);
  assert.equal(c.window.pinned, true);
  c.shortcuts.pin();
  assert.equal(c.snapshot().pinned, false);
  assert.equal(c.window.pinned, false);
  c.shortcuts.pin();
  assert.equal(c.snapshot().pinned, true);
});

test('opacity shortcuts change only the background and never fade foreground text', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view');
  assert.equal(c.snapshot().opacity, 0.65);
  assert.equal(c.window.opacity, 1);
  assert.equal(c.window.options.transparent, true);
  assert.equal(c.window.options.frame, false);
  assert.equal(c.window.options.backgroundColor, '#00000000');
  assert.equal(c.window.options.backgroundMaterial, 'none');
  assert.equal(c.window.rootBackground, '#00000000');
  assert.equal(c.window.material, 'none');
  assert.equal(c.getView().options.webPreferences.transparent, true);
  assert.equal(c.window.backgroundColor, '#00000000');
  assert.equal(c.getView().backgroundColor, '#00000000');
  c.shortcuts.opacityDown();
  assert.equal(c.getOpacity(), 0.6);
  assert.equal(c.window.opacity, 1);
  await new Promise(setImmediate);
  const styles = [...c.getView().webContents.styles.values()];
  assert.equal(styles.length, 1, 'rapid updates retain only the latest stylesheet');
  assert.match(styles[0], /rgba\(24, 26, 30, 0\.6\)/);
  c.shortcuts.opacityUp();
  assert.equal(c.getOpacity(), 0.65);
  for (let i = 0; i < 30; i++) c.shortcuts.opacityUp();
  assert.equal(c.getOpacity(), 1);
  for (let i = 0; i < 30; i++) c.shortcuts.opacityDown();
  assert.equal(c.getOpacity(), 0.2);
  c.shortcuts.opacityUp();
  assert.equal(c.getOpacity(), 0.25);
  assert.equal(c.window.opacity, 1);
  assert.equal(c.events.some(e => e[0] === 'material' && e[1] !== 'none'), false,
    'the system never paints a backdrop beneath the translucent surface');
});

test('approval and revoked pages stay solid and stale glass updates cannot recolor them', async () => {
  const c = harness();
  await c.openViewer('https://example.com/access');
  assert.equal(c.window.backgroundColor, '#00000000');
  assert.equal(c.getView().backgroundColor, '#10151d');
  assert.equal(c.getView().webContents.styles.size, 0);
  const wc = c.getView().webContents;
  wc.navigate('https://example.com/?role=view');
  wc.setPageTitle('Live Workspace — Ready');
  c.adjustOpacity(-0.1);
  wc.setPageTitle('Live Workspace — Access required');
  await new Promise(setImmediate);
  assert.equal(c.window.backgroundColor, '#00000000');
  assert.equal(c.getView().backgroundColor, '#10151d');
  assert.equal(wc.styles.size, 0);
  assert.equal(c.window.opacity, 1);
});

test('approval and admin pages stay visible, opaque and clickable until authorized viewer is ready', async () => {
  const c = harness();
  c.window.emit('ready-to-show');
  for (const route of ['/access', '/access-admin', '/login']) {
    const result = await c.openViewer(`https://example.com${route}`);
    assert.equal(result.ok, true);
    assert.equal(result.interactivePage, true);
    assert.equal(c.window.visible, true);
    assert.equal(c.window.opacity, 1);
    assert.equal(c.snapshot().clickThrough, false);
    c.setToolbarVisible(false);
    assert.equal(c.snapshot().toolbarHidden, false, 'approval forms retain controls');
    c.setClickThrough(true);
    c.setPointerOverToolbar(false);
    c.adjustOpacity(-0.5);
    assert.equal(c.window.ignoreMouse, false);
    assert.equal(c.window.opacity, 1);
  }
  const wc = c.getView().webContents;
  wc.navigate('https://example.com/?role=view');
  assert.equal(c.window.visible, true);
  wc.setPageTitle('Live Workspace — Access required');
  assert.equal(c.snapshot().interactivePage, true);
  wc.setPageTitle('Live Workspace — Ready');
  assert.equal(c.snapshot().interactivePage, false);
  assert.equal(c.snapshot().clickThrough, false);
  assert.equal(c.snapshot().linkHidden, true);
  assert.equal(c.window.visible, true);
});

test('revocation restores interactive mode and preserves overlay preferences after reapproval', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view');
  c.setClickThrough(false);
  c.adjustOpacity(-0.35);
  const wc = c.getView().webContents;
  wc.setPageTitle('Live Workspace — Access required');
  assert.equal(c.window.visible, true);
  assert.equal(c.window.opacity, 1);
  assert.equal(c.window.ignoreMouse, false);
  assert.equal(c.snapshot().clickThrough, false);
  assert.equal(c.snapshot().toolbarHidden, false);
  assert.equal(c.getView().bounds.y, 128);
  wc.navigate('https://example.com/access');
  wc.setPageTitle('Live Workspace — Ready');
  assert.equal(c.snapshot().interactivePage, true, 'ready title cannot turn an approval page into an overlay');
  wc.navigate('https://example.com/?role=view');
  wc.setPageTitle('Live Workspace — Ready');
  assert.equal(c.getOpacity(), 0.3);
  assert.equal(c.window.opacity, 1, 'reapproval restores surface alpha without fading text');
  assert.equal(c.snapshot().clickThrough, false, 'preserve manually disabled click-through');
  assert.equal(c.snapshot().toolbarHidden, true);
  assert.equal(c.getView().bounds.y, 44);
  assert.equal(c.window.visible, true, 'reapproval does not unexpectedly hide the window again');
});

test('stale replaced renderers cannot change window interaction mode', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view');
  const old = c.getView().webContents;
  await c.openViewer('https://example.com/access');
  old.setPageTitle('Live Workspace — Ready');
  assert.equal(c.snapshot().interactivePage, true);
  assert.equal(c.window.visible, true);
});

test('shortcut conflict leaves a recoverable taskbar window and disables hide', async () => {
  const c = harness({ shortcut: false });
  c.window.emit('ready-to-show');
  c.hide();
  assert.equal(c.window.skipTaskbar, false);
  assert.equal(c.window.visible, true);
  assert.equal(c.snapshot().shortcut, false);
  assert.equal((await c.openViewer('https://example.com/?role=view&key=test')).ok, true);
  assert.equal(c.window.visible, true);
});

test('reopening a viewer disposes its previous renderer; closing disposes the final one', async () => {
  const c = harness();
  await c.openViewer('https://example.com/?role=view&key=first');
  const first = c.getView().webContents;
  await c.openViewer('https://example.com/?role=view&key=second');
  assert.equal(first.isDestroyed(), true);
  const last = c.getView().webContents;
  c.window.close();
  assert.equal(last.isDestroyed(), true);
  assert.equal(c.handlers.size, 0);
  assert.equal(c.shortcuts.handlers.has('Control+Alt+B'), false);
});
