const assert = require("node:assert/strict");
const { test } = require("node:test");
const { page, flush, response } = require("./ui-harness");

for (const storedAutoCopy of [undefined, "false", "true"]) {
  test(`opening a viewer does not override relay settings (stored: ${storedAutoCopy})`, async t => {
    const h = await page(t, "viewer", { local: storedAutoCopy === undefined ? {} : { "lw-auto-copy": storedAutoCopy } });
    const socket = h.sockets[0];
    assert.ok(socket, "viewer connects after access check");
    socket.readyState = 1; socket.onopen();
    h.receive({ type: "auth", role: "edit", clientId: "c1" });
    h.receive({ type: "autoCopy", on: true });
    assert.equal(socket.sent.length, 0);
    assert.equal(h.el("autoCopyBtn").textContent, "Auto Copy: ON");
    h.receive({ type: "autoCopy", on: false });
    assert.equal(h.el("autoCopyBtn").textContent, "Auto Copy: OFF");
    assert.equal(socket.sent.length, 0, "server state must not be echoed back");
  });
}

test("unapproved viewer is never ready and redirects to the same-origin request page", async t => {
  const h = await page(t, "viewer", { search: "?role=view&overlay=1&key=old-link", fetch: async () => response({ ok: false, approvalRequired: true }, 403) });
  assert.equal(h.document.title, "Live Workspace — Access required");
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(h.navigations, ["/access?overlay=1"]);
  assert.equal(h.el("answer").textContent, "");
});

test("owner unlock retains editor key, opens dashboard in same tab, and exposes no secret viewer link", async t => {
  const h = await page(t, "viewer", { search: "?role=edit&key=owner-test", fetch: async (url, init) => {
    if (url === "/api/unlock") { assert.equal(JSON.parse(init.body).password, "test-password"); return response({ ok: true, token: "gate-test" }); }
    if (url.startsWith("/api/share-links")) return response({ viewLink: "https://workspace.test/access", editLink: "https://workspace.test/?role=edit&key=owner-test" });
    const params = new URL(url, "https://workspace.test").searchParams;
    return params.get("gate") === "gate-test" ? response({ ok: true, role: "edit", approvalEnabled: true }) : response({ ok: false, passwordRequired: true }, 401);
  } });
  assert.equal(h.document.title, "Live Workspace — Access required");
  assert.equal(h.el("passwordGate").classList.contains("hidden"), false);
  h.el("passwordInput").value = "test-password";
  await h.submit("passwordForm");
  assert.equal(h.document.title, "Live Workspace — Ready");
  assert.equal(h.window.sessionStorage.getItem("lw-key"), "owner-test");
  assert.equal(h.window.sessionStorage.getItem("lw-gate"), "gate-test");
  assert.equal(h.el("passwordInput").value, "");
  assert.equal(h.el("accessAdminBtn").classList.contains("hidden"), false);
  await h.click("shareBtn"); await h.click("copyLinkBtn");
  assert.equal(h.clipboard.at(-1), "https://workspace.test/access");
  await h.click("accessAdminBtn");
  assert.deepEqual(h.navigations, ["/access-admin"]);
});

test("approved viewers are read-only and revocation clears answer content before redirect", async t => {
  let revoked = false;
  const h = await page(t, "viewer", { search: "?role=view", fetch: async () => revoked ? response({ ok: false, approvalRequired: true }, 403) : response({ ok: true, role: "view", approvalEnabled: true }) });
  assert.equal(h.document.title, "Live Workspace — Ready");
  assert.equal(h.el("answer").contentEditable, "false");
  assert.equal(h.el("autoCopyBtn").disabled, true);
  h.receive({ type: "sync", from: "server", text: "## Private answer\n\n**Formatted text**" });
  assert.equal(h.el("answer").querySelector("h2").textContent, "Private answer");
  revoked = true; h.sockets[0].onclose({ code: 1008 });
  assert.equal(h.el("answer").textContent, "", "cleared synchronously before the auth check completes");
  await flush();
  assert.equal(h.document.title, "Live Workspace — Access required");
  assert.deepEqual(h.navigations, ["/access"]);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 2000), false);
});

test("owner read-only password expiry shows password gate instead of guest approval", async t => {
  let expired = false;
  const h = await page(t, "viewer", { search: "?role=view&key=owner-test", storage: { "lw-gate": "old-gate" }, fetch: async () => expired ? response({ ok: false, passwordRequired: true }, 401) : response({ ok: true, role: "view" }) });
  expired = true; h.sockets[0].onclose({ code: 1008 }); await flush();
  assert.equal(h.navigations.length, 0);
  assert.equal(h.el("passwordGate").classList.contains("hidden"), false);
  assert.equal(h.document.title, "Live Workspace — Access required");
});

test("temporary network failure retries without requiring a new approval", async t => {
  let fail = false;
  const h = await page(t, "viewer", { search: "?role=view", fetch: async () => { if (fail) throw new Error("offline"); return response({ ok: true, role: "view" }); } });
  h.receive({ type: "sync", from: "server", text: "Existing answer" });
  h.sockets[0].onclose({ code: 1006 }); fail = true; await h.tick(2000);
  assert.equal(h.navigations.length, 0); assert.match(h.el("answer").textContent, /Existing answer/);
  fail = false; await h.tick(3000);
  assert.equal(h.sockets.length, 2); assert.equal(h.document.title, "Live Workspace — Ready");
});

test("explicit legacy mode retains server-provided keyed share links", async t => {
  const h = await page(t, "viewer", { fetch: async url => url.startsWith("/api/share-links") ? response({ viewLink: "https://workspace.test/?role=view&key=legacy-test", editLink: "owner" }) : response({ ok: true, role: "edit", approvalEnabled: false }) });
  await h.click("shareBtn"); await h.click("copyLinkBtn");
  assert.equal(h.clipboard.at(-1), "https://workspace.test/?role=view&key=legacy-test");
});
