const serverEl = document.getElementById("server");
const healthEl = document.getElementById("health");
const lastSentEl = document.getElementById("lastSent");
const queueEl = document.getElementById("queue");
const testBtn = document.getElementById("testBtn");
const wakeBtn = document.getElementById("wakeBtn");

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
    lastSentEl.textContent = res.lastSentAt
      ? new Date(res.lastSentAt).toLocaleTimeString()
      : "—";

    if (res.health?.ok) {
      setHealth(true, "Online");
    } else {
      setHealth(false, res.health?.error ? "Offline" : `Error ${res.health?.status || ""}`.trim());
    }
  });
}

testBtn.addEventListener("click", () => {
  testBtn.disabled = true;
  testBtn.textContent = "Testing…";
  chrome.runtime.sendMessage({ type: "wake", force: true }, (res) => {
    testBtn.disabled = false;
    testBtn.textContent = "Test server";
    if (chrome.runtime.lastError) {
      setHealth(false, "Failed");
      return;
    }
    setHealth(Boolean(res?.ok), res?.ok ? "Online" : "Offline");
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
