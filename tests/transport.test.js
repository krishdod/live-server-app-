"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the real worker against a browser/server simulator. Never load config.js:
// these values are deliberately fake and every request stays inside this file.
const workerSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const SERVER = "https://relay.example.invalid";
const KEY = "test-only-stream-key";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
    listeners
  };
}

async function settle() {
  // Drain asynchronous storage operations and response handlers, without
  // depending on wall-clock time or Chrome's actual alarm scheduler.
  await new Promise((resolve) => setImmediate(resolve));
}

function createWorker({ disk = {}, answer = async () => response(200) } = {}) {
  const requests = [];
  const warnings = [];
  const alarms = [];
  const timers = new Map();
  const onMessage = event();
  const onAlarm = event();
  let timerId = 0;
  let activePosts = 0;
  let maxActivePosts = 0;
  const context = vm.createContext({
    SERVER_URL: SERVER + "/",
    STREAM_KEY: KEY,
    importScripts(filename) { assert.equal(filename, "config.js"); },
    AbortController,
    console: { warn(...args) { warnings.push(args); } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { timers.set(++timerId, fn); return timerId; },
    clearInterval(id) { timers.delete(id); },
    chrome: {
      storage: {
        local: {
          async get(key) { return structuredClone({ [key]: disk[key] }); },
          async set(value) { Object.assign(disk, structuredClone(value)); }
        }
      },
      runtime: {
        onMessage,
        onConnect: event(),
        onInstalled: event(),
        onStartup: event()
      },
      alarms: {
        onAlarm,
        async create(name, options) { alarms.push({ name, ...options }); }
      }
    },
    async fetch(url, options = {}) {
      assert.ok(url === SERVER + "/health" || url === SERVER + "/answer");
      const request = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      if (url.endsWith("/health")) return response(200, { ok: true, clients: 1, autoCopyEnabled: true });
      assert.equal(request.method, "POST");
      assert.equal(request.body.key, KEY);
      activePosts += 1;
      maxActivePosts = Math.max(maxActivePosts, activePosts);
      try { return await answer(request.body); } finally { activePosts -= 1; }
    }
  });
  vm.runInContext(workerSource, context, { filename: "background.js" });
  return {
    disk, requests, warnings, alarms,
    get posts() { return requests.filter((request) => request.method === "POST"); },
    get maxActivePosts() { return maxActivePosts; },
    async message(message) {
      return new Promise((resolve, reject) => {
        const result = onMessage.listeners[0](message, {}, (value) => resolve(structuredClone(value)));
        if (result !== true && message.type !== "ping") reject(new Error("Worker did not keep the response channel open"));
      });
    },
    async retry() {
      onAlarm.emit({ name: "retry-relay-delivery" });
      await settle();
    }
  };
}

test("a healthy server does not conceal a rejected delivery key", async () => {
  const worker = createWorker({ answer: async () => response(403) });
  await settle();

  const delivery = await worker.message({ type: "answer", text: "An answer to relay" });
  const status = await worker.message({ type: "status" });
  assert.equal(delivery.sent, false);
  assert.equal(delivery.status, 403);
  assert.equal(delivery.retryable, false);
  assert.match(delivery.error, /key rejected/i);
  assert.equal(status.health.ok, true);
  assert.equal(status.health.status, 200);
  assert.equal(status.delivery.sent, false);
  assert.equal(status.delivery.status, 403);
  assert.equal(status.queueSize, 1);
  assert.equal(status.lastSentAt, 0);

  // Permanent configuration failures stay visible without hammering the server.
  await worker.retry();
  assert.equal(worker.posts.length, 1);
  assert.equal(worker.warnings.length, 0);
});

test("the newest unsent snapshot survives worker shutdown and is retried on restart", async () => {
  const disk = {};
  const first = createWorker({ disk, answer: async () => { throw new Error("offline"); } });
  await settle();
  await first.message({ type: "answer", text: "Partial answer" });
  await first.message({ type: "answer", text: "The completed newest answer" });

  assert.equal(disk.relayDelivery.pendingAnswer.text, "The completed newest answer");
  assert.equal(disk.relayDelivery.lastDelivery.status, 0);
  assert.equal(disk.relayDelivery.lastDelivery.retryable, true);

  // A fresh VM has none of the first worker's variables; only storage persists.
  const restarted = createWorker({ disk });
  await settle();
  assert.deepEqual(restarted.posts.map((request) => request.body.text), ["The completed newest answer"]);
  assert.equal(disk.relayDelivery.pendingAnswer, null);
  assert.ok(disk.relayDelivery.lastSentAt > 0);
  assert.equal((await restarted.message({ type: "status" })).queueSize, 0);
  assert.ok(restarted.alarms.some((alarm) => alarm.name === "retry-relay-delivery"));
  assert.equal(restarted.warnings.length, 0);
});

test("a failed old request cannot be replayed after a newer snapshot is accepted", async () => {
  const oldRequest = deferred();
  const worker = createWorker({
    answer: async (body) => body.text === "Old partial answer" ? oldRequest.promise : response(200)
  });
  await settle();

  const oldResult = worker.message({ type: "answer", text: "Old partial answer" });
  await settle();
  assert.equal(worker.posts.length, 1);
  const middleResult = worker.message({ type: "answer", text: "Intermediate answer" });
  const newestResult = worker.message({ type: "answer", text: "Newest completed answer" });
  await settle();
  assert.equal(worker.posts.length, 1, "new snapshots must not overtake the in-flight request");
  assert.equal(worker.disk.relayDelivery.pendingAnswer.text, "Newest completed answer");

  oldRequest.resolve(response(503));
  await Promise.all([oldResult, middleResult, newestResult]);
  await worker.retry();
  await worker.retry();

  assert.deepEqual(worker.posts.map((request) => request.body.text), ["Old partial answer", "Newest completed answer"]);
  assert.equal(worker.maxActivePosts, 1);
  assert.equal(worker.disk.relayDelivery.pendingAnswer, null);
  assert.equal(worker.disk.relayDelivery.lastDelivery.sent, true);
  assert.equal(worker.warnings.length, 0);
});

test("success of an in-flight partial answer does not discard a newer captured answer", async () => {
  const oldRequest = deferred();
  const worker = createWorker({
    answer: async (body) => body.text === "Partial" ? oldRequest.promise : response(200)
  });
  await settle();
  const firstResult = worker.message({ type: "answer", text: "Partial" });
  await settle();
  const latestResult = worker.message({ type: "answer", text: "Complete" });
  await settle();

  oldRequest.resolve(response(200));
  await Promise.all([firstResult, latestResult]);
  assert.deepEqual(worker.posts.map((request) => request.body.text), ["Partial", "Complete"]);
  assert.equal(worker.maxActivePosts, 1);
  assert.equal(worker.disk.relayDelivery.pendingAnswer, null);
});

test("test-delivery authenticates without sending a replacement answer", async () => {
  const worker = createWorker();
  await settle();
  const result = await worker.message({ type: "test-delivery" });

  assert.equal(result.sent, true);
  assert.equal(worker.posts.length, 1);
  assert.deepEqual(worker.posts[0].body, { check: true, key: KEY });
  assert.equal(Object.hasOwn(worker.posts[0].body, "text"), false);
  const status = await worker.message({ type: "status" });
  assert.equal(status.delivery.checkOnly, true);
  assert.equal(status.lastSentAt, 0, "a key check is not an answer delivery");
  assert.equal(status.queueSize, 0);
});

test("test-delivery leaves a queued answer untouched until an explicit retry", async () => {
  let online = false;
  const worker = createWorker({
    answer: async () => online ? response(200) : response(503)
  });
  await settle();
  await worker.message({ type: "answer", text: "Queued before checking the connection" });
  assert.equal(worker.disk.relayDelivery.pendingAnswer.text, "Queued before checking the connection");

  online = true;
  const result = await worker.message({ type: "test-delivery" });
  await settle();
  assert.equal(result.sent, true);
  assert.equal(worker.posts.length, 2, "the test must not trigger a third request with queued text");
  assert.deepEqual(worker.posts[1].body, { check: true, key: KEY });
  assert.equal(worker.disk.relayDelivery.pendingAnswer.text, "Queued before checking the connection");
  assert.equal((await worker.message({ type: "status" })).lastSentAt, 0);

  await worker.retry();
  assert.equal(worker.posts.length, 3);
  assert.equal(worker.posts[2].body.text, "Queued before checking the connection");
  assert.equal(worker.disk.relayDelivery.pendingAnswer, null);
});

test("queued captions are not restored to a different configured server", async () => {
  const disk = {
    relayDelivery: {
      server: "https://previous-relay.example.invalid",
      pendingAnswer: { text: "A previous session's private answer", capturedAt: 1 },
      lastDelivery: { sent: false, retryable: true }
    }
  };
  const worker = createWorker({ disk });
  await settle();
  assert.equal(worker.posts.length, 0);
  assert.equal((await worker.message({ type: "status" })).queueSize, 0);
});
