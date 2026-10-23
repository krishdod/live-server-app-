const serverEl = document.getElementById("server");
const healthEl = document.getElementById("health");
const lastSentEl = document.getElementById("lastSent");
const queueEl = document.getElementById("queue");
const testBtn = document.getElementById("testBtn");
const wakeBtn = document.getElementById("wakeBtn");
const deliveryEl = document.getElementById("delivery");
const capturedEl = document.getElementById("lastCaptured");
const clientsEl = document.getElementById("clients");
const settings = document.getElementById("settings");
const serverInput = document.getElementById("serverInput");
const keyInput = document.getElementById("keyInput");
const settingsNotice = document.getElementById("settingsNotice");
let settingsLoaded = false;

function setDelivery(result) {
  deliveryEl.textContent = !result ? "Waiting for an answer"
    : result.sent ? (result.checkOnly ? "Key accepted" : "Answer accepted")
    : result.error || `Failed (HTTP ${result.status || 0})`;
  deliveryEl.className = `value ${!result ? "muted" : result.sent ? "ok" : "bad"}`;
}

function setHealth(ok, detail) {
  healthEl.textContent = detail;
  healthEl.className = `value ${ok ? "ok" : "bad"}`;
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "status" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setHealth(false, "Extension error");
      return;
    }

    serverEl.textContent = res.server || "—";
    if (!settingsLoaded) {
      serverInput.value = res.server || "https://live-server-app.onrender.com";
      keyInput.placeholder = res.keyConfigured ? "Saved key · enter a new one to replace" : "Paste STREAM_KEY from Render";
      settingsLoaded = true;
      if (!res.keyConfigured || res.delivery?.status === 403) settings.open = true;
    }
    queueEl.textContent = String(res.queueSize ?? 0);
    setDelivery(res.delivery);
    clientsEl.textContent = String(res.health?.clients ?? "—");
    capturedEl.textContent = res.lastCapturedAt
      ? new Date(res.lastCapturedAt).toLocaleTimeString() : "—";
    lastSentEl.textContent = res.lastSentAt
      ? new Date(res.lastSentAt).toLocaleTimeString()
      : "—";

    if (res.health?.ok) {
      setHealth(true, res.health.autoCopyEnabled === false ? "Online · Auto Copy OFF" : "Online");
    } else {
      setHealth(false, res.health?.error ? "Offline" : `Error ${res.health?.status || ""}`.trim());
    }
  });
}

testBtn.addEventListener("click", () => {
  testBtn.disabled = true;
  testBtn.textContent = "Testing…";
  chrome.runtime.sendMessage({ type: "test-delivery" }, (res) => {
    testBtn.disabled = false;
    testBtn.textContent = "Test delivery";
    if (chrome.runtime.lastError) {
      setDelivery({ sent: false, error: "Extension error. Reload the extension." });
      return;
    }
    setDelivery(res);
    refreshStatus();
  });
});

wakeBtn.addEventListener("click", () => {
  wakeBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "wake", force: true }, () => {
    wakeBtn.disabled = false;
    refreshStatus();
  });
});

refreshStatus();
document.getElementById("connectionForm").addEventListener("submit", event => {
  event.preventDefault();
  const button = document.getElementById("saveConnection");
  button.disabled = true;
  settingsNotice.textContent = "Saving…";
  chrome.runtime.sendMessage({ type: "save-connection", server: serverInput.value, key: keyInput.value }, result => {
    button.disabled = false;
    if (chrome.runtime.lastError || !result?.ok) {
      settingsNotice.textContent = result?.error || "Could not save. Reload the extension and try again.";
      settingsNotice.className = "hint bad";
      return;
    }
    keyInput.value = "";
    keyInput.placeholder = result.keyConfigured ? "Saved key · enter a new one to replace" : "Paste STREAM_KEY from Render";
    settingsNotice.className = "hint ok";
    settingsNotice.textContent = "Saved. Choose Test delivery, then ask a new question.";
    refreshStatus();
  });
});
setInterval(refreshStatus, 4000);
