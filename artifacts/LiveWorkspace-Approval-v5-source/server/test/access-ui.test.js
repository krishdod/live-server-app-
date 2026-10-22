const assert = require("node:assert/strict");
const { test } = require("node:test");
const { page, flush, response } = require("./ui-harness");

const pending = { enabled: true, status: "pending", name: "A viewer", code: "A12B-C34D", pendingExpiresAt: Date.now() + 1200000 };
const request = { id: "request-one", code: pending.code, name: pending.name, status: "pending", createdAt: Date.now(), pendingExpiresAt: pending.pendingExpiresAt };

test("request form posts a name and polling opens only the approved same-origin viewer", async t => {
  let state = { enabled: true, status: "none" };
  const h = await page(t, "access", { search: "?overlay=1&next=https://attacker.invalid", fetch: async (url, init) => {
    if (url === "/api/access/request") {
      assert.deepEqual(JSON.parse(init.body), { name: "A viewer" });
      assert.equal(init.credentials, "same-origin"); state = pending;
    }
    return response(state);
  } });
  assert.equal(h.el("requestForm").hidden, false);
  h.el("name").value = "  A viewer  "; await h.submit("requestForm");
  assert.equal(h.el("requestForm").hidden, true);
  assert.equal(h.el("requestCode").textContent, pending.code);
  assert.equal(h.navigations.length, 0);
  state = { ...pending, status: "approved" }; await h.tick(3000);
  assert.deepEqual(h.navigations, ["/?role=view&overlay=1"]);
  assert.equal(h.timers.size, 0, "polling stops after navigation");
});

test("cancel request clears the waiting code and restores request form", async t => {
  const h = await page(t, "access", { fetch: async (url, init) => {
    if (url === "/api/access/end") { assert.equal(init.method, "POST"); return response({ status: "none" }); }
    return response(pending);
  } });
  await h.click("endBtn");
  assert.equal(h.el("requestForm").hidden, false);
  assert.equal(h.el("requestDetails").hidden, true);
  assert.equal(h.el("requestCode").textContent, "");
  assert.equal(h.navigations.length, 0);
});

for (const state of ["rejected", "revoked", "expired"]) {
  test(`${state} request stays blocked and offers a new request`, async t => {
    const h = await page(t, "access", { fetch: async () => response({ ...pending, status: state }) });
    assert.equal(h.navigations.length, 0);
    assert.equal(h.el("requestForm").hidden, false);
    assert.equal(h.el("requestCode").textContent, "");
    assert.match(h.el("notice").textContent, state === "rejected" ? /declined/ : state === "revoked" ? /ended/ : /expired/);
  });
}

test("connection errors back off and recover without duplicating a request", async t => {
  let offline = true;
  const h = await page(t, "access", { fetch: async () => { if (offline) throw new Error("offline"); return response(pending); } });
  assert.match(h.el("notice").textContent, /Connection interrupted/);
  await h.tick(6000); await h.tick(12000);
  offline = false; await h.tick(24000);
  assert.equal(h.el("requestCode").textContent, pending.code);
  assert.equal([...h.timers.values()][0].delay, 3000);
  assert.equal(h.calls.filter(call => call.url === "/api/access/request").length, 0);
});

test("owner sign-in approves and revokes only the selected request and safely renders names", async t => {
  const unsafeName = '<img src=x onerror="alert(1)">';
  let rows = [{ ...request, name: unsafeName }, { ...request, id: "request-two", code: "E56F-A78B", name: "Other viewer" }];
  const changes = [];
  const h = await page(t, "access-admin", { fetch: async (url, init) => {
    if (url === "/api/unlock") {
      assert.equal(JSON.parse(init.body).password, "owner-password");
      return response({ ok: true, token: "owner-gate" });
    }
    assert.equal(init.headers["X-Owner-Key"], "owner-key");
    assert.equal(init.headers["X-Owner-Gate"], "owner-gate");
    if (init.method === "POST") {
      const change = JSON.parse(init.body); changes.push(change);
      rows = rows.map(row => row.id !== change.id ? row : { ...row, status: change.action === "approve" ? "approved" : "revoked", expiresAt: Date.now() + 3600000 });
      return response({ ok: true });
    }
    return response({ requests: rows });
  } });
  assert.equal(h.calls.length, 0, "credentials are not guessed or sent before sign-in");
  h.el("ownerKey").value = "owner-key"; h.el("ownerPassword").value = "owner-password";
  await h.submit("ownerForm");
  assert.equal(h.el("dashboard").hidden, false);
  assert.equal(h.el("ownerKey").value, ""); assert.equal(h.el("ownerPassword").value, "");
  assert.equal(h.el("requests").querySelector("img"), null);
  assert.match(h.el("requests").textContent, /<img/);
  h.el("requests").querySelectorAll(".request-row")[1].querySelector("button").click(); await flush();
  assert.deepEqual(changes[0], { id: "request-two", action: "approve", duration: "hour" });
  h.el("requests").querySelectorAll(".request-row")[1].querySelector("button").click(); await flush();
  assert.deepEqual(changes[1], { id: "request-two", action: "revoke" });
  await h.click("copyViewerLink"); assert.equal(h.clipboard.at(-1), "https://workspace.test/access");
  assert.equal(h.document.querySelector('a[href="/?role=edit"]').getAttribute("target"), null);
});

test("expired owner credentials clear dashboard requests and return to login", async t => {
  let expired = false;
  const h = await page(t, "access-admin", { storage: { "lw-key": "owner-key", "lw-gate": "gate" }, fetch: async () => expired ? response({ error: "Owner access required" }, 403) : response({ requests: [request] }) });
  assert.equal(h.el("dashboard").hidden, false);
  expired = true; await h.click("refreshBtn");
  assert.equal(h.el("ownerForm").hidden, false);
  assert.equal(h.el("requests").textContent, "");
  assert.equal(h.el("dashboard").hidden, true);
});

test("signing out while a refresh is pending cannot reopen the owner dashboard", async t => {
  let release, pendingRefresh = false;
  const h = await page(t, "access-admin", { storage: { "lw-key": "owner-key" }, fetch: async () => {
    if (pendingRefresh) return new Promise(resolve => { release = resolve; });
    return response({ requests: [request] });
  } });
  pendingRefresh = true; await h.click("refreshBtn");
  await h.click("ownerSignOut");
  release(response({ requests: [request] })); await flush();
  assert.equal(h.el("dashboard").hidden, true);
  assert.equal(h.el("requests").textContent, "");
  assert.equal(h.window.sessionStorage.getItem("lw-key"), null);
  assert.equal(h.timers.size, 0);
});
