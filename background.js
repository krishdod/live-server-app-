importScripts("config.js");

const BASE_URL = SERVER_URL.replace(/\/+$/, "");
const HTTP_ENDPOINT = `${BASE_URL}/answer`;
const HEALTH_ENDPOINT = `${BASE_URL}/health`;
const REQUEST_TIMEOUT_MS = 12000;
const STORAGE_KEY = "relayDelivery";
const RETRY_ALARM = "retry-relay-delivery";

let lastWakeAt = 0;
let lastSentAt = 0;
let lastCapturedAt = 0;
let lastHealth = { ok: false };
let lastDelivery = null;
let pendingAnswer = null;
let flushPromise = null;
let healthPromise = null;
let savePromise = Promise.resolve();

// Updates are full snapshots; keep only the newest unsent answer.
// Persist it because Chrome can stop the worker between retries.
const ready = chrome.storage.local.get(STORAGE_KEY).then((data) => {
  const saved = data[STORAGE_KEY];
  if (!saved || saved.server !== BASE_URL) return;
  pendingAnswer = typeof saved.pendingAnswer?.text === "string" ? saved.pendingAnswer : null;
  lastSentAt = saved.lastSentAt || 0;
  lastCapturedAt = saved.lastCapturedAt || 0;
  lastDelivery = saved.lastDelivery || null;
});

function saveState() {
  const state = { server: BASE_URL, pendingAnswer, lastSentAt, lastCapturedAt, lastDelivery };
  savePromise = savePromise.catch(() => {}).then(() => chrome.storage.local.set({ [STORAGE_KEY]: state }));
  return savePromise;
}

async function wakeServer(force = false) {
  if (healthPromise) return healthPromise;
  if (!force && Date.now() - lastWakeAt < 30000) return lastHealth;
  lastWakeAt = Date.now();
  healthPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(HEALTH_ENDPOINT, { cache: "no-store", signal: controller.signal });
      const body = response.ok ? await response.json() : {};
      lastHealth = {
        ok: response.ok && body.ok === true, status: response.status,
        clients: body.clients, autoCopyEnabled: body.autoCopyEnabled
      };
    } catch {
      lastHealth = { ok: false, status: 0, error: "Server unreachable or waking up" };
    } finally { clearTimeout(timer); }
    return lastHealth;
  })();
  try { return await healthPromise; } finally { healthPromise = null; }
}

function deliveryError(status) {
  if (status === 401 || status === 403) return "Key rejected. Match STREAM_KEY in config.js with the server.";
  if (status === 404) return "Answer endpoint missing. Check SERVER_URL in config.js.";
  if (status === 413) return "Answer is too large for the server.";
  if (status === 429) return "Server busy. The latest answer is queued.";
  return status ? `Delivery failed (HTTP ${status}).` : "Server unreachable or waking up. The latest answer is queued.";
}

async function requestDelivery(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(HTTP_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, key: STREAM_KEY || "" }),
      signal: controller.signal
    });
    return {
      sent: response.ok, status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      error: response.ok ? "" : deliveryError(response.status)
    };
  } catch {
    return { sent: false, status: 0, retryable: true, error: deliveryError(0) };
  } finally { clearTimeout(timer); }
}

async function flushQueue(force = false) {
  await ready;
  if (flushPromise) return flushPromise;
  if (!pendingAnswer) return { sent: true, idle: true };
  if (!force && lastDelivery?.retryable === false && !lastDelivery.sent) return lastDelivery;
  flushPromise = (async () => {
    let result;
    while (pendingAnswer) {
      const item = pendingAnswer;
      result = await requestDelivery({ text: item.text });
      lastDelivery = { ...result, checkedAt: Date.now() };
      if (result.sent) {
        lastSentAt = Date.now();
        // Do not discard an update received while this request was in flight.
        if (pendingAnswer === item) pendingAnswer = null;
      }
      await saveState();
      if (!result.sent) break;
    }
    return result;
  })();
  try { return await flushPromise; } finally { flushPromise = null; }
}

async function queueAnswer(text) {
  await ready;
  lastCapturedAt = Date.now();
  pendingAnswer = { text, capturedAt: lastCapturedAt };
  await saveState();
  return flushQueue(true);
}

async function getStatus() {
  await ready;
  return {
    server: BASE_URL, health: await wakeServer(), delivery: lastDelivery,
    lastCapturedAt, lastSentAt, queueSize: pendingAnswer ? 1 : 0
  };
}

async function testDelivery() {
  await ready;
  // Omitting text checks the key without replacing the viewer's answer.
  const result = await requestDelivery({ check: true });
  lastDelivery = { ...result, checkedAt: Date.now(), checkOnly: true };
  await saveState();
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  let task;
  if (msg?.type === "ping") {
    sendResponse({ ok: true, server: BASE_URL });
    return;
  }
  if (msg?.type === "status") task = getStatus();
  else if (msg?.type === "wake") task = wakeServer(Boolean(msg.force));
  else if (msg?.type === "test-delivery") task = testDelivery();
  else if (msg?.type === "answer" && typeof msg.text === "string") task = queueAnswer(msg.text);
  else return;

  task.then(sendResponse).catch((error) => {
    console.warn("[Live Workspace] Relay error", error);
    sendResponse({ sent: false, ok: false, error: "Extension storage or delivery failed. Reload the extension." });
  });
  return true;
});

function retryPending() { void flushQueue().catch(console.warn); }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "live-workspace") return;
  retryPending();
  const heartbeat = setInterval(() => {
    try { port.postMessage({ type: "tick" }); } catch { clearInterval(heartbeat); }
    retryPending();
  }, 20000);
  port.onDisconnect.addListener(() => clearInterval(heartbeat));
  port.onMessage.addListener(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) retryPending();
});

async function initialize() {
  await ready;
  await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  retryPending();
}
chrome.runtime.onInstalled.addListener(() => { void initialize().catch(console.warn); });
chrome.runtime.onStartup.addListener(() => { void initialize().catch(console.warn); });
void initialize().catch(console.warn);
