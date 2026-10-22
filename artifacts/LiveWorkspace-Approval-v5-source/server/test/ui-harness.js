const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

async function page(t, name, options = {}) {
  const html = fs.readFileSync(path.join(root, `${name}.html`), "utf8");
  const url = new URL(`${name === "viewer" ? "/" : `/${name}`}${options.search || ""}`, "https://workspace.test");
  const dom = new JSDOM(html, { url: url.href, runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  for (const [key, value] of Object.entries(options.storage || {})) window.sessionStorage.setItem(key, value);
  for (const [key, value] of Object.entries(options.local || {})) window.localStorage.setItem(key, value);
  const calls = [], navigations = [], timers = new Map(), sockets = [], clipboard = [];
  let timerId = 0;
  const location = { protocol: url.protocol, host: url.host, origin: url.origin, search: url.search,
    get href() { return url.href; }, set href(value) { navigations.push(value); }, replace(value) { navigations.push(value); } };
  class FakeWebSocket {
    static OPEN = 1;
    constructor(address) { this.url = address; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const context = vm.createContext({ window, document: window.document,
    navigator: { clipboard: { writeText: async value => clipboard.push(value) } },
    location, sessionStorage: window.sessionStorage, localStorage: window.localStorage,
    URLSearchParams, URL, Node: window.Node, NodeFilter: window.NodeFilter, CSS: {}, WebSocket: FakeWebSocket,
    fetch: async (url, init = {}) => { calls.push({ url, init }); return options.fetch ? options.fetch(url, init) : response({ ok: true, role: "edit", secured: false, approvalEnabled: false }); },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {}, console
  });
  if (name === "viewer") {
    for (const filename of ["vendor/marked.umd.js", "vendor/purify.min.js", "markdown.js"]) window.eval(fs.readFileSync(path.join(root, filename), "utf8"));
    context.marked = window.marked; context.DOMPurify = window.DOMPurify; context.LiveMarkdown = window.LiveMarkdown;
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  } else vm.runInContext(fs.readFileSync(path.join(root, `${name}.js`), "utf8"), context);
  await flush();
  return { window, document: window.document, calls, navigations, timers, sockets, clipboard, context,
    el: id => window.document.getElementById(id),
    async click(id) { window.document.getElementById(id).click(); await flush(); },
    async submit(id) { window.document.getElementById(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await flush(); },
    async tick(delay) { const match = [...timers].find(([, timer]) => delay === undefined || timer.delay === delay); if (!match) throw new Error(`No timer with delay ${delay}`); timers.delete(match[0]); match[1].callback(); await flush(); },
    receive(message, socket = sockets.at(-1)) { socket.onmessage({ data: JSON.stringify(message) }); }
  };
}
module.exports = { page, flush, response };
