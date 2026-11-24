"use strict";

const DEFAULT_ACCESS_URL = "https://live-server-app.onrender.com/access";
const RETRYABLE = new Set(["ERR_FAILED", "ERR_NETWORK_CHANGED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_INTERNET_DISCONNECTED"]);

function networkCode(value) {
  return String(value || "").match(/\bERR_[A-Z0-9_]+\b/)?.[0] || null;
}

async function loadPage(contents, url, timeoutMs = 90000) {
  let timer;
  try {
    await Promise.race([
      contents.loadURL(url),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("Page load timed out"), { code: "ERR_TIMED_OUT" }));
          contents.stop?.();
        }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { DEFAULT_ACCESS_URL, RETRYABLE, networkCode, loadPage };
