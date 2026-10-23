(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  let timer;
  let busy = false;
  let failures = 0;
  let active = true;
  const viewerPath = new URLSearchParams(location.search).get("overlay") === "1"
    ? "/?role=view&overlay=1" : "/?role=view";

  function notice(message, error = false) {
    byId("notice").textContent = message;
    byId("notice").classList.toggle("error", error);
  }
  function continueToViewer() {
    active = false;
    clearTimeout(timer);
    location.replace(viewerPath);
  }
  function showStatus(data) {
    failures = 0;
    const state = data.status || "none";
    if (data.enabled === false || state === "approved") {
      byId("heading").textContent = "Access approved";
      notice("Opening your live workspace…");
      continueToViewer();
      return;
    }
    const pending = state === "pending";
    byId("requestForm").hidden = pending;
    byId("requestDetails").hidden = !pending;
    byId("heading").textContent = pending ? "Waiting for approval" : "Ask the owner for access";
    byId("description").textContent = pending
      ? "Share this code with the owner so they can identify your request. This window opens automatically when they approve."
      : "Enter your name, then share your request code with the owner. Only the owner can approve access.";
    byId("requestCode").textContent = pending ? data.code || "" : "";
    byId("copyCodeBtn").textContent = "Copy code";
    byId("requestStatus").textContent = pending ? `Request from ${data.name || "you"}` : "";
    byId("requestExpiry").textContent = pending && data.pendingExpiresAt
      ? `Request expires ${new Date(data.pendingExpiresAt).toLocaleString()}.` : "";
    const messages = {
      none: "", pending: "Waiting for the owner…",
      rejected: "The owner declined this request. You can request access again.",
      revoked: "The owner ended your access. Request approval to use the workspace again.",
      expired: "Your access or request expired. Request approval again to continue."
    };
    notice(messages[state] || "Request access to continue.");
  }
  function schedule() {
    clearTimeout(timer);
    if (active) timer = setTimeout(checkStatus, Math.min(3000 * (2 ** failures), 30000));
  }
  async function checkStatus() {
    if (!active || busy) return;
    busy = true;
    try {
      const response = await fetch("/api/access/status", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Unavailable");
      showStatus(await response.json());
    } catch {
      failures = Math.min(failures + 1, 4);
      notice("Connection interrupted. Checking again automatically…", true);
    } finally {
      busy = false;
      schedule();
    }
  }
  byId("requestForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = byId("name").value.trim();
    if (!name || busy) return;
    busy = true;
    byId("requestBtn").disabled = true;
    clearTimeout(timer);
    notice("Sending your request…");
    try {
      const response = await fetch("/api/access/request", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not request access. Try again.");
      showStatus(data);
    } catch (error) {
      notice(error.message || "Could not request access. Try again.", true);
    } finally {
      busy = false;
      byId("requestBtn").disabled = false;
      schedule();
    }
  });
  byId("endBtn").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    byId("endBtn").disabled = true;
    try {
      const response = await fetch("/api/access/end", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      if (!response.ok) throw new Error("Could not cancel. Try again.");
      showStatus({ enabled: true, status: "none" });
    } catch (error) { notice(error.message, true); }
    finally { busy = false; byId("endBtn").disabled = false; schedule(); }
  });
  byId("copyCodeBtn").addEventListener("click", async () => {
    const code = byId("requestCode").textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      byId("copyCodeBtn").textContent = "Copied";
      notice("Request code copied. Send it to the owner.");
    } catch { notice("Select your request code and copy it to share with the owner."); }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !busy) checkStatus();
  });
  window.addEventListener("pagehide", () => { active = false; clearTimeout(timer); });
  checkStatus();
})();
