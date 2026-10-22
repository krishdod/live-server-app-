const serverEl = document.getElementById("server");
const healthEl = document.getElementById("health");
const lastSentEl = document.getElementById("lastSent");
const queueEl = document.getElementById("queue");
const testBtn = document.getElementById("testBtn");
const wakeBtn = document.getElementById("wakeBtn");
const deliveryEl = document.getElementById("delivery");
const capturedEl = document.getElementById("lastCaptured");
const clientsEl = document.getElementById("clients");

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
    serverEl.className = "value";
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
    testBtn.textContent = "Test answer delivery";
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
setInterval(refreshStatus, 4000);
