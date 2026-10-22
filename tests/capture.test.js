const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const hookSource = fs.readFileSync(path.join(__dirname, "..", "page-hook.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const assistant = (text, extra = {}) => ({
  author: { role: "assistant" }, content: { parts: [text] }, ...extra
});
const frame = (value) => "data: " + JSON.stringify(value) + "\n\n";
const sse = (body) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function hook(fetch) {
  const events = [];
  const listeners = {};
  const window = {
    fetch, postMessage: (event) => events.push(event),
    addEventListener: (type, fn) => { listeners[type] = fn; }
  };
  vm.runInNewContext(hookSource, {
    window, location: { origin: "https://chatgpt.com", pathname: "/c/current" },
    URL, TextDecoder, console
  });
  return {
    window, events,
    answers: () => events.filter((event) => event.type === "answer").map((event) => event.text),
    requestState: () => listeners.message({ source: window, data: { source: "__LIVE_WORKSPACE_STREAM__", type: "request-state" } })
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the capture hook");
}

async function capture(body) {
  const h = hook(async () => sse(body));
  await h.window.fetch("/backend-api/f/conversation", { method: "POST" });
  await waitFor(() => h.events.some((event) => event.type === "stream-end"));
  return h;
}

test("captures compact snapshots, append deltas and inherited paths", async () => {
  const h = await capture(
    frame({ o: "add", p: "", v: { message: assistant("") } }) +
    frame({ o: "append", p: "/message/content/parts/0", v: "Hello" }) +
    frame({ v: " world" })
  );
  assert.equal(h.answers().at(-1), "Hello world");
});

test("applies patch batches, relative paths, and replacement part arrays", async () => {
  const h = await capture(
    frame({ message: assistant("Old text") }) +
    frame({ o: "patch", p: "/message", v: [
      { o: "replace", p: "/content/parts", v: ["New"] },
      { o: "append", p: "/content/parts/0", v: " answer" }
    ] })
  );
  assert.equal(h.answers().at(-1), "New answer");
});

test("captures the final SSE event without a terminating newline", async () => {
  const h = await capture("data: " + JSON.stringify({ message: assistant("Final answer") }));
  assert.deepEqual(h.answers(), ["Final answer"]);
});

test("parses multiline SSE data and CRLF split across byte chunks", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"message":\r\ndata: ' + JSON.stringify(assistant("Hi 🌍")) + "}\r\n\r\n"
  );
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    }
  });
  const h = await capture(stream);
  assert.equal(h.answers().at(-1), "Hi 🌍");
});

test("uses the selected conversation branch, not longer/newer alternatives", async () => {
  const h = hook(async () => json({
    current_node: "chosen",
    mapping: {
      old: { parent: null, message: assistant("Long previous answer ".repeat(30), { create_time: 1 }) },
      chosen: { parent: "old", message: assistant("Yes", { create_time: 2 }) },
      alternate: { parent: "old", message: assistant("Another branch", { create_time: 3 }) }
    }
  }));
  await h.window.fetch("/backend-api/conversation/current");
  await waitFor(() => h.answers().length > 0);
  assert.deepEqual(h.answers(), ["Yes"]);
});

test("history without a selected branch uses time, never answer length", async () => {
  const h = hook(async () => json({
    mapping: {
      newest: { message: assistant("New", { create_time: 2 }) },
      oldest: { message: assistant("Old answer ".repeat(30), { create_time: 1 }) }
    }
  }));
  await h.window.fetch("/backend-api/conversation/current");
  await waitFor(() => h.answers().length > 0);
  assert.deepEqual(h.answers(), ["New"]);
});

test("does not relay user, hidden reasoning, or tool-directed messages", async () => {
  const h = await capture(
    frame({ message: assistant("User prompt", { author: { role: "user" } }) }) +
    frame({ message: assistant("Hidden reasoning", { channel: "analysis" }) }) +
    frame({ message: assistant("Tool command", { recipient: "python" }) }) +
    frame({ message: assistant("Visible answer", { channel: "final" }) })
  );
  assert.deepEqual(h.answers(), ["Visible answer"]);
});

test("replays an answer and completion when content loaded after the stream", async () => {
  const h = await capture(frame({ message: assistant("Already complete") }));
  h.events.length = 0;
  h.requestState();
  assert.deepEqual(h.events.map((event) => event.type), ["answer", "stream-end"]);
  assert.deepEqual(h.answers(), ["Already complete"]);
});

test("a late response from an earlier request cannot overwrite the latest reply", async () => {
  let resolveOld;
  let calls = 0;
  const h = hook(() => ++calls === 1
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve(sse(frame({ message: assistant("Latest") }))));
  const oldRequest = h.window.fetch("/backend-api/conversation", { method: "POST" });
  await h.window.fetch(new URL("https://chatgpt.com/backend-api/conversation"), { method: "POST" });
  await waitFor(() => h.events.some((event) => event.type === "stream-end"));
  resolveOld(sse(frame({ message: assistant("Stale") })));
  await oldRequest;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(h.answers(), ["Latest"]);
});

function content() {
  const listeners = {};
  const messages = [];
  let candidates = [];
  let answerResponse = { sent: true };
  const document = {
    body: {}, querySelector: () => null,
    querySelectorAll: (selector) => selector.includes('[data-message-author-role="assistant"]') ? candidates : [],
    addEventListener: () => {}
  };
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    postMessage: () => {}, scrollY: 0
  };
  window.top = window;
  const context = vm.createContext({
    window, document, location: {
      href: "https://chatgpt.com/c/current", pathname: "/c/current",
      hostname: "chatgpt.com", origin: "https://chatgpt.com"
    },
    history: { pushState() {}, replaceState() {} },
    chrome: { runtime: {
      connect: () => ({ onDisconnect: { addListener() {} } }),
      sendMessage: (message, cb) => { messages.push(message); cb(answerResponse); }
    } },
    MutationObserver: class { observe() {} },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    URL, console: { log() {}, error() {} }
  });
  vm.runInContext(contentSource, context);
  return {
    context, messages,
    respondWith: (value) => { answerResponse = value; },
    candidates: (value) => { candidates = value; },
    run: (code) => vm.runInContext(code, context),
    event: (event) => listeners.message({ source: window, data: {
      source: "__LIVE_WORKSPACE_STREAM__", ...event
    } })
  };
}

const element = (text, top = 0) => ({
  innerText: text, textContent: text, text,
  closest: () => null, contains: () => false,
  getBoundingClientRect: () => ({ top }),
  querySelectorAll: () => [], children: [], childNodes: [],
  cloneNode() { return this; }, getAttribute() {}, tagName: "DIV"
});

test("DOM capture selects the latest short reply over a long older reply", () => {
  const c = content();
  const old = element("Long old answer ".repeat(1000));
  const latest = element("OK", 100);
  c.candidates([old, latest]);
  assert.equal(c.run("getAnswerContainer()"), latest);
  assert.equal(c.run("getLatestAnswer()"), "OK");
});

test("empty current assistant turn does not fall back to previous answer", () => {
  const c = content();
  c.candidates([element("Old answer"), element("")]);
  assert.equal(c.run("getLatestAnswer()"), "");
});

test("completed network snapshot cannot hide a subsequent DOM-only answer", () => {
  const c = content();
  const current = element("Current answer");
  c.candidates([current]);
  c.event({ type: "stream-start", requestId: 1 });
  c.event({ type: "answer", requestId: 1, text: "Current answer" });
  c.event({ type: "stream-end", requestId: 1 });
  assert.equal(c.run("getLatestAnswer()"), "Current answer");
  c.candidates([current, element("Next answer")]);
  assert.equal(c.run("getLatestAnswer()"), "Next answer");
});

test("starting another request clears the previous network snapshot", () => {
  const c = content();
  c.candidates([element("Visible first answer")]);
  c.event({ type: "answer", requestId: 1, text: "Old network answer" });
  c.event({ type: "stream-start", requestId: 2 });
  c.candidates([element("New streamed answer")]);
  assert.equal(c.run("getLatestAnswer()"), "New streamed answer");
  c.event({ type: "answer", requestId: 1, text: "Late old answer" });
  assert.equal(c.run("getLatestAnswer()"), "New streamed answer");
});

test("paragraph extraction preserves spaces between adjacent blocks", () => {
  const c = content();
  assert.equal(c.run('joinBlocks(["First paragraph", "Second paragraph"])'), "First paragraph\n\nSecond paragraph");
});

test("permanent relay rejection does not retry the same answer on each tick", async () => {
  const c = content();
  c.candidates([element("Rejected answer")]);
  c.respondWith({ sent: false, status: 403, retryable: false });
  c.run('previousAnswer = "Rejected answer"; lastExtractedLen = previousAnswer.length');
  await c.run('sendAnswer(previousAnswer)');
  c.run("tick(); tick()");
  assert.equal(c.messages.filter((message) => message.type === "answer").length, 1);
});

test("transient relay failure remains eligible for retry", async () => {
  const c = content();
  c.candidates([element("Pending answer")]);
  c.respondWith({ sent: false, status: 503, retryable: true });
  c.run('previousAnswer = "Pending answer"; lastExtractedLen = previousAnswer.length');
  await c.run('sendAnswer(previousAnswer)');
  c.respondWith({ sent: true });
  c.run("tick()");
  assert.equal(c.messages.filter((message) => message.type === "answer").length, 2);
});
