(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  let ownerKey = sessionStorage.getItem("lw-key") || "";
  let gate = sessionStorage.getItem("lw-gate") || "";
  let timer;
  let busy = false;
  let active = true;
  let authenticated = false;
  let sessionGeneration = 0;

  function notice(message, error = false) {
    byId("notice").textContent = message;
    byId("notice").classList.toggle("error", error);
  }
  function showLogin(message) {
    authenticated = false;
    clearTimeout(timer);
    byId("dashboard").hidden = true;
    byId("requests").replaceChildren();
    byId("ownerForm").hidden = false;
    notice(message || "Enter your owner key and workspace password to continue.");
  }
  function headers() {
    return { "Content-Type": "application/json", "X-Owner-Key": ownerKey, "X-Owner-Gate": gate };
  }
  function label(parent, tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  function renderRequests(requests) {
    const fragment = document.createDocumentFragment();
    for (const request of requests) {
      const card = document.createElement("article");
      card.className = "request-row";
      card.dataset.state = request.status;
      const heading = label(card, "h2", request.name || "Viewer");
      label(heading, "span", request.status, "pill");
      label(card, "p", request.code, "request-code");
      label(card, "p", `Requested ${new Date(request.createdAt).toLocaleString()}`, "muted");
      const expiry = request.status === "pending" ? request.pendingExpiresAt : request.expiresAt;
      if (expiry && ["pending", "approved"].includes(request.status)) {
        label(card, "p", `Expires ${new Date(expiry).toLocaleString()}`, "muted");
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      function button(text, action, duration, className) {
        const node = label(actions, "button", text, className);
        node.type = "button";
        node.addEventListener("click", () => changeAccess(request.id, action, duration));
      }
      if (request.status === "pending") {
        button("Approve for 1 hour", "approve", "hour");
        button("Approve for 24 hours", "approve", "day", "secondary");
        button("Reject", "reject", undefined, "secondary");
      } else if (request.status === "approved") {
        button("Revoke access", "revoke", undefined, "danger");
      }
      card.append(actions);
      fragment.append(card);
    }
    byId("requests").replaceChildren(fragment);
    byId("pendingCount").textContent = String(requests.filter(row => row.status === "pending").length);
    byId("approvedCount").textContent = String(requests.filter(row => row.status === "approved").length);
    byId("emptyState").hidden = requests.length > 0;
  }
  function schedule() {
    clearTimeout(timer);
    if (active && authenticated) timer = setTimeout(() => {
      if (document.hidden) schedule(); else refresh();
    }, 5000);
  }
  async function refresh(keepNotice = false) {
    if (busy || !active) return;
    const generation = sessionGeneration;
    busy = true;
    try {
      const response = await fetch("/api/access/admin", { headers: headers(), cache: "no-store" });
      if (generation !== sessionGeneration || !active) return;
      if (response.status === 401 || response.status === 403) {
        showLogin("Owner access is required. Enter your owner key and password.");
        return;
      }
      const data = await response.json();
      if (generation !== sessionGeneration || !active) return;
      if (!response.ok) throw new Error(data.error || "Could not load requests.");
      authenticated = true;
      sessionStorage.setItem("lw-key", ownerKey);
      sessionStorage.setItem("lw-role", "edit");
      if (gate) sessionStorage.setItem("lw-gate", gate);
      byId("ownerForm").hidden = true;
      byId("dashboard").hidden = false;
      renderRequests(data.requests || []);
      if (!keepNotice) notice("Requests update automatically while this page is open.");
    } catch (error) {
      notice(error.message || "Connection interrupted. Trying again…", true);
      if (!authenticated) byId("ownerForm").hidden = false;
    } finally { busy = false; schedule(); }
  }
  async function changeAccess(id, action, duration) {
    if (busy) return;
    const generation = sessionGeneration;
    busy = true;
    clearTimeout(timer);
    byId("requests").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch("/api/access/admin", {
        method: "POST", headers: headers(), body: JSON.stringify({ id, action, duration })
      });
      const data = await response.json();
      if (generation !== sessionGeneration || !active) return;
      if (response.status === 401 || response.status === 403) {
        showLogin("Your owner session expired. Sign in again.");
        return;
      }
      if (!response.ok) throw new Error(data.error || "Could not update access.");
      notice(action === "approve" ? "Access approved. The viewer will open automatically."
        : action === "reject" ? "Request rejected." : "Viewer access revoked.");
    } catch (error) { notice(error.message, true); }
    finally {
      busy = false;
      byId("requests").querySelectorAll("button").forEach((button) => { button.disabled = false; });
      if (authenticated) await refresh(true);
    }
  }
  byId("ownerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const candidate = byId("ownerKey").value.trim();
    if (!candidate) return;
    busy = true;
    byId("ownerLoginBtn").disabled = true;
    try {
      const password = byId("ownerPassword").value;
      if (password) {
        const response = await fetch("/api/unlock", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not unlock. Check the password.");
        gate = data.token || "";
      }
      ownerKey = candidate;
      byId("ownerPassword").value = "";
      byId("ownerKey").value = "";
      busy = false;
      await refresh();
    } catch (error) { notice(error.message, true); }
    finally { busy = false; byId("ownerLoginBtn").disabled = false; }
  });
  byId("copyViewerLink").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/access`);
      notice("Viewer link copied. It contains no owner key.");
    } catch { notice(`Copy this viewer link: ${location.origin}/access`); }
  });
  byId("refreshBtn").addEventListener("click", () => refresh());
  byId("ownerSignOut").addEventListener("click", () => {
    sessionGeneration += 1;
    ownerKey = ""; gate = "";
    ["lw-key", "lw-gate", "lw-role"].forEach((key) => sessionStorage.removeItem(key));
    showLogin("Signed out in this tab.");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && authenticated) refresh();
  });
  window.addEventListener("pagehide", () => { active = false; clearTimeout(timer); });
  if (ownerKey) refresh(); else showLogin();
})();
