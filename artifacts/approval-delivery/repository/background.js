importScripts("config.js");

const HTTP_ENDPOINT = `${SERVER_URL}/answer`;
const HEALTH_ENDPOINT = `${SERVER_URL}/health`;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_QUEUE = 20;

let lastWakeAt = 0;
let lastSentAt = 0;
let lastHealth = { ok: false };
let offlineQueue = [];
let flushing = false;

async function wakeServer(force = false) {
  const now = Date.now();
  if (!force && now - lastWakeAt < 30000) {
    return lastHealth.ok ? { ok: true, cached: true } : lastHealth;
  }
  lastWakeAt = now;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(HEALTH_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timer);
    lastHealth = { ok: response.ok, status: response.status };
    if (lastHealth.ok) {
      flushQueue();
    }
    return lastHealth;
  } catch (err) {
    clearTimeout(timer);
    console.warn("[Live Workspace] Wake failed", err);
    lastHealth = { ok: false, error: String(err) };
    return lastHealth;
  }
}

function enqueue(text) {
  offlineQueue.push({ text, ts: Date.now() });
  if (offlineQueue.length > MAX_QUEUE) {
    offlineQueue = offlineQueue.slice(-MAX_QUEUE);
  }
}

async function flushQueue() {
  if (flushing || !offlineQueue.length) return;
  flushing = true;

  try {
    while (offlineQueue.length) {
      const item = offlineQueue[0];
      const result = await postAnswer(item.text, 0, false);
      if (!result.sent) break;
      offlineQueue.shift();
    }
  } finally {
    flushing = false;
  }
}

async function postAnswer(text, attempt = 0, useQueue = true) {
  if (attempt === 0) {
    await wakeServer();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(HTTP_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, key: STREAM_KEY || "" }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (response.ok) {
      lastSentAt = Date.now();
      lastHealth = { ok: true, status: response.status };
      return { sent: true, status: response.status };
    }

    if (attempt < MAX_RETRIES && response.status >= 500) {
      await wakeServer(true);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      return postAnswer(text, attempt + 1, useQueue);
    }

    if (useQueue && response.status >= 500) {
      enqueue(text);
    }

    return { sent: false, status: response.status };
  } catch (err) {
    clearTimeout(timer);
    console.error("[Live Workspace] SEND FAILED", err);
    if (attempt < MAX_RETRIES) {
      await wakeServer(true);
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      return postAnswer(text, attempt + 1, useQueue);
    }
    if (useQueue) {
      enqueue(text);
    }
    return { sent: false, status: 0 };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ping") {
    sendResponse({ ok: true, server: SERVER_URL });
    return;
  }

  if (msg?.type === "status") {
    wakeServer().then((health) => {
      sendResponse({
        server: SERVER_URL,
        health,
        lastSentAt,
        queueSize: offlineQueue.length
      });
    });
    return true;
  }

  if (msg?.type === "wake") {
    wakeServer(Boolean(msg.force)).then(sendResponse);
    return true;
  }

  if (msg?.type !== "answer" || typeof msg.text !== "string") {
    return;
  }

  postAnswer(msg.text).then(sendResponse);
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "live-workspace") return;
  wakeServer();
  const heartbeat = setInterval(() => {
    try {
      port.postMessage({ type: "tick" });
      wakeServer();
      flushQueue();
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  port.onDisconnect.addListener(() => clearInterval(heartbeat));
  port.onMessage.addListener(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  wakeServer(true);
});

chrome.runtime.onStartup.addListener(() => {
  wakeServer(true);
});

setInterval(() => {
  wakeServer();
  flushQueue();
}, 45000);
