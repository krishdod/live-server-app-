const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const { test } = require("node:test");
const WebSocket = require("ws");
const { ApprovalStore, PENDING_TTL_MS, TERMINAL_TTL_MS, DURATIONS } = require("../approval");

const OWNER = "test-only-owner-key";
const PASSWORD = "test-only-password";
const STREAM = "test-only-stream-key";

async function startServer(t, extraEnv = {}) {
  const entry = path.join(__dirname, "..", "server.js");
  // Time travel is confined to this child test process, never the server API.
  const script = `const realNow=Date.now; let offset=0; Date.now=()=>realNow()+offset;
    process.on('message',m=>{offset+=m.advance; process.send('advanced');});
    require(${JSON.stringify(entry)});`;
  const child = spawn(process.execPath, ["-e", script], {
    env: {
      ...process.env, PORT: "0", EDIT_KEY: OWNER, VIEW_KEY: "legacy-view-key",
      STREAM_KEY: STREAM, APP_PASSWORD: "", APP_ORIGIN: "", NODE_ENV: "test",
      RENDER: "", VIEWER_APPROVAL_REQUIRED: "true", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "",
      ...extraEnv
    },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill(); await exited;
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 5000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Server running on port (\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (pathname, { cookie, gate, owner = false, method = "GET", body, origin = base, headers = {} } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method, headers: {
        ...(origin !== null ? { Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(gate ? { "X-Owner-Gate": gate } : {}),
        ...(owner ? { "X-Owner-Key": OWNER } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers
      }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { response, status: response.status, json, text, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const newRequest = (name = "Viewer", opts = {}) => request("/api/access/request", { method: "POST", body: { name }, ...opts });
  const admin = async (id, action, duration = "hour", gate) => request("/api/access/admin", {
    owner: true, gate, method: "POST", body: { id, action, duration }
  });
  const approve = async (pending, duration = "hour", gate) => {
    const list = await request("/api/access/admin", { owner: true, gate });
    assert.equal(list.status, 200);
    const row = list.json.requests.find((item) => item.code === pending.json.code);
    assert.ok(row);
    assert.equal((await admin(row.id, "approve", duration, gate)).status, 200);
    return row.id;
  };
  const connect = ({ cookie, query = "role=view", origin = base } = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?${query}`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }
    });
    const messages = [];
    socket.on("error", () => {});
    socket.on("message", (raw) => messages.push(JSON.parse(raw)));
    const closed = once(socket, "close");
    t.after(() => socket.terminate());
    const next = async (predicate) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Expected websocket message missing");
    };
    return { socket, messages, closed, next };
  };
  const publish = (text, key = STREAM) => request("/answer", { method: "POST", body: { text, key }, origin: null });
  const advance = async (ms) => {
    const ack = once(child, "message"); child.send({ advance: ms }); await ack;
  };
  return { request, newRequest, admin, approve, connect, publish, advance, base };
}

test("approval store uses private tokens, fixed expiry, bounded retention and request limits", () => {
  let time = 1000;
  const store = new ApprovalStore({ now: () => time, maxRequests: 2, maxRateEntries: 1 });
  const one = store.create("One");
  assert.match(one.token, /^[a-f0-9]{64}$/);
  assert.equal(store.byToken(one.row.code), null);
  assert.equal(store.byToken(one.row.id), null);
  assert.equal(store.create("changed", one.token).token, null);
  assert.equal(store.change(one.row.id, "approve", "hour").status, 200);
  const expiry = one.row.expiresAt;
  assert.equal(store.change(one.row.id, "approve", "day").status, 409, "cannot silently extend approved sessions");
  assert.equal(one.row.expiresAt, expiry);
  time = expiry;
  assert.equal(store.isApproved(one.row.id), false);
  assert.equal(store.byToken(one.token).status, "expired");
  const two = store.create("Two");
  assert.throws(() => store.create("Three"), /Too many/);
  time += PENDING_TTL_MS;
  assert.equal(store.change(two.row.id, "approve", "day").status, 409, "stale pending requests cannot be approved");
  time += TERMINAL_TTL_MS;
  assert.equal(store.list().length, 0);
  for (let i = 0; i < 10; i++) assert.equal(store.allowAttempt("one-address"), true);
  assert.equal(store.allowAttempt("one-address"), false);
  assert.equal(store.allowAttempt("another-address"), false, "rate limiter memory also bounded");
});

test("legacy links and request codes cannot bypass approval; owner and publishing still work", async (t) => {
  const s = await startServer(t);
  const denied = await s.request("/auth?role=view&key=legacy-view-key");
  assert.equal(denied.status, 403); assert.equal(denied.json.approvalRequired, true);
  assert.equal(denied.json.approvalEnabled, true);
  const socket = s.connect({ query: "role=view&key=legacy-view-key" });
  assert.equal((await socket.closed)[0], 1008); assert.equal(socket.messages.length, 0);
  const pending = await s.newRequest("Test viewer");
  assert.equal(pending.status, 200); assert.equal(pending.json.status, "pending");
  assert.match(pending.response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await s.request(`/auth?role=view&key=${pending.json.code}`)).status, 403);
  assert.equal((await s.request("/auth?role=view", { cookie: pending.cookie })).status, 403);
  assert.equal((await s.request(`/auth?role=edit&key=${OWNER}`)).status, 200);
  assert.equal((await s.publish("published" )).status, 204);
  assert.equal((await s.publish("bad", "wrong")).status, 403);
  const links = await s.request(`/api/share-links?role=edit&key=${OWNER}`);
  assert.equal(links.json.viewLink, `${s.base}/access`);
  assert.equal(JSON.stringify(links.json.viewLink).includes(OWNER), false);
});

test("approved sessions are read-only, reconnect, and revoke immediately", async (t) => {
  const s = await startServer(t);
  const pending = await s.newRequest(); const id = await s.approve(pending);
  const auth = await s.request("/auth?role=view", { cookie: pending.cookie });
  assert.equal(auth.status, 200); assert.equal(auth.json.role, "view");
  assert.equal((await s.request("/auth?role=edit", { cookie: pending.cookie })).status, 403);
  assert.equal((await s.request("/api/access/admin", { cookie: pending.cookie })).status, 403);
  assert.equal((await s.request("/api/sync", {
    method: "POST", cookie: pending.cookie, body: { role: "edit", text: "stolen edit" }
  })).status, 403);
  const viewer = s.connect({ cookie: pending.cookie });
  await viewer.next((msg) => msg.type === "auth");
  assert.equal((await viewer.next((msg) => msg.from === "server")).text, "");
  viewer.socket.send(JSON.stringify({ type: "sync", text: "not allowed" }));
  viewer.socket.send(JSON.stringify({ type: "autoCopy", on: false }));
  await s.publish("real answer");
  assert.equal((await viewer.next((msg) => msg.from === "stream")).text, "real answer");
  const reconnected = s.connect({ cookie: pending.cookie });
  assert.equal((await reconnected.next((msg) => msg.from === "server")).text, "real answer");
  assert.equal((await s.admin(id, "revoke")).status, 200);
  assert.equal((await viewer.closed)[0], 1008); assert.equal((await reconnected.closed)[0], 1008);
  const deniedReconnect = s.connect({ cookie: pending.cookie });
  assert.equal((await deniedReconnect.closed)[0], 1008);
  assert.equal((await s.request("/auth?role=view", { cookie: pending.cookie })).status, 403);
  assert.equal((await s.request("/api/access/status", { cookie: pending.cookie })).json.status, "revoked");
});

test("expired sessions receive no later broadcast and cannot reconnect", async (t) => {
  const s = await startServer(t);
  const pending = await s.newRequest(); await s.approve(pending);
  const viewer = s.connect({ cookie: pending.cookie }); await viewer.next((msg) => msg.type === "auth");
  await s.advance(DURATIONS.hour);
  await s.publish("after expiry");
  assert.equal((await viewer.closed)[0], 1008);
  assert.equal(viewer.messages.some((msg) => msg.text === "after expiry"), false);
  assert.equal((await s.request("/api/access/status", { cookie: pending.cookie })).json.status, "expired");
  assert.equal((await s.connect({ cookie: pending.cookie }).closed)[0], 1008);
});

test("owner password applies to admin and owner view links; viewer approval needs no owner password", async (t) => {
  const s = await startServer(t, { APP_PASSWORD: PASSWORD });
  assert.equal((await s.request("/api/access/admin", { owner: true })).status, 403);
  const denied = await s.request(`/auth?role=view&key=${OWNER}`);
  assert.equal(denied.status, 401); assert.equal(denied.json.passwordRequired, true);
  assert.equal((await s.request(`/api/gate?role=view&key=${OWNER}&overlay=1`)).json.required, true);
  assert.equal((await s.request(`/api/gate?role=edit&overlay=1`)).json.required, true);
  assert.equal((await s.request("/api/unlock", { method: "POST", body: { password: "bad" } })).status, 403);
  const gate = (await s.request("/api/unlock", { method: "POST", body: { password: PASSWORD } })).json.token;
  assert.ok(gate);
  assert.equal((await s.request(`/auth?role=view&key=${OWNER}&gate=${gate}`)).status, 200);
  const pending = await s.newRequest(); await s.approve(pending, "hour", gate);
  assert.equal((await s.request("/auth?role=view", { cookie: pending.cookie })).status, 200);
  const socket = s.connect({ query: `role=edit&key=${OWNER}&gate=${gate}` });
  await socket.next((msg) => msg.type === "auth");
  await s.advance(DURATIONS.day);
  await s.publish("gate expired");
  assert.equal((await socket.closed)[0], 1008);
  assert.equal((await s.request("/api/access/admin", { owner: true, gate })).status, 403);
});

test("approval mutations reject missing/foreign origins, and requests are limited", async (t) => {
  const s = await startServer(t);
  assert.equal((await s.newRequest("Viewer", { origin: "https://evil.invalid" })).status, 403);
  assert.equal((await s.newRequest("Viewer", { origin: null })).status, 403);
  assert.equal((await s.newRequest("Viewer", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  const cors = await s.request("/api/access/status", { origin: "https://chatgpt.com" });
  assert.equal(cors.response.headers.get("access-control-allow-origin"), null);
  assert.equal((await s.newRequest("x".repeat(81))).status, 400);
  assert.equal((await s.newRequest(" ")).status, 400);
  const pending = await s.newRequest();
  const id = await s.approve(pending);
  assert.equal((await s.request("/api/access/admin", {
    method: "POST", owner: true, body: { id, action: "revoke" }, origin: "https://evil.invalid"
  })).status, 403);
  assert.equal((await s.request("/api/access/end", { method: "POST", cookie: pending.cookie, origin: null })).status, 403);
  const crossSite = s.connect({ cookie: pending.cookie, origin: "https://evil.invalid" });
  assert.equal((await crossSite.closed)[0], 1008);
  for (let i = 0; i < 7; i++) assert.equal((await s.newRequest(`Viewer ${i}`)).status, 200);
  assert.equal((await s.newRequest("Extra", { headers: { "X-Forwarded-For": "203.0.113.55" } })).status, 429);
});

test("request end, rejection, stale approval, and server restart invalidate access", async (t) => {
  const s = await startServer(t);
  const pending = await s.newRequest("Ended"); await s.approve(pending);
  const ended = await s.request("/api/access/end", { method: "POST", cookie: pending.cookie });
  assert.equal(ended.status, 200); assert.match(ended.response.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await s.request("/auth?role=view", { cookie: pending.cookie })).status, 403);
  const rejected = await s.newRequest("Rejected");
  let rows = (await s.request("/api/access/admin", { owner: true })).json.requests;
  const rejectedId = rows.find((row) => row.code === rejected.json.code).id;
  assert.equal((await s.admin(rejectedId, "reject")).status, 200);
  assert.equal((await s.request("/api/access/status", { cookie: rejected.cookie })).json.status, "rejected");
  assert.equal((await s.admin(rejectedId, "approve")).status, 409);
  const stale = await s.newRequest("Stale");
  rows = (await s.request("/api/access/admin", { owner: true })).json.requests;
  const staleId = rows.find((row) => row.code === stale.json.code).id;
  await s.advance(PENDING_TTL_MS);
  assert.equal((await s.admin(staleId, "approve")).status, 409);
  const active = await s.newRequest("Active"); await s.approve(active, "day");
  const restarted = await startServer(t);
  assert.equal((await restarted.request("/auth?role=view", { cookie: active.cookie })).status, 403);
  assert.equal((await restarted.request("/api/access/status", { cookie: active.cookie })).json.status, "none");
});

test("missing owner key fails closed by default", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: "0", EDIT_KEY: "", VIEWER_APPROVAL_REQUIRED: "" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0); assert.match(stderr, /EDIT_KEY must be set/);
});

test("hosted ingest stays fail-closed without stream key; approval cookies are secure on HTTPS", async (t) => {
  const origin = "https://workspace.example";
  const s = await startServer(t, { APP_ORIGIN: origin, STREAM_KEY: "" });
  assert.equal((await s.publish("unauthenticated", "")).status, 403);
  assert.equal((await s.newRequest()).status, 403);
  const pending = await s.newRequest("Hosted", { origin });
  assert.equal(pending.status, 200); assert.match(pending.response.headers.get("set-cookie"), /; Secure/);
});

for (const [setting, message] of [
  [{ VIEW_KEY: OWNER }, /EDIT_KEY and VIEW_KEY must be different/],
  [{ STREAM_KEY: OWNER }, /EDIT_KEY and STREAM_KEY must be different/],
  [{ RENDER: "true", APP_ORIGIN: "" }, /APP_ORIGIN must be set/]
]) {
  test(`unsafe approval configuration fails closed: ${Object.keys(setting).join(", ")}`, async () => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: "0", EDIT_KEY: OWNER, VIEW_KEY: "other-view-key",
        STREAM_KEY: STREAM, RENDER: "", NODE_ENV: "test", APP_ORIGIN: "",
        VIEWER_APPROVAL_REQUIRED: "true", ...setting },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0); assert.match(stderr, message);
  });
}

test("approval is explicitly advertised as disabled in legacy mode", async (t) => {
  const s = await startServer(t, { VIEWER_APPROVAL_REQUIRED: "false" });
  const auth = await s.request("/auth?role=view&key=legacy-view-key");
  assert.equal(auth.status, 200);
  assert.equal(auth.json.approvalEnabled, false);
  assert.equal((await s.request("/api/access/status")).json.enabled, false);
});

test("invalid actions cannot grant access and terminal requests cannot be revived", async (t) => {
  const s = await startServer(t);
  const pending = await s.newRequest("Viewer");
  const list = await s.request("/api/access/admin", { owner: true });
  const id = list.json.requests[0].id;
  assert.equal((await s.admin(id, "approve", "forever")).status, 400);
  assert.equal((await s.admin(id, "unknown")).status, 400);
  assert.equal((await s.admin("unknown", "approve")).status, 404);
  assert.equal((await s.request("/api/access/status", { cookie: pending.cookie })).json.status, "pending");
  const approvedCookie = pending.cookie;
  await s.approve(pending);
  assert.equal((await s.admin(id, "revoke")).status, 200);
  assert.equal((await s.admin(id, "approve")).status, 409);
  const replacement = await s.newRequest("Viewer again", { cookie: pending.cookie });
  assert.equal(replacement.json.status, "pending");
  assert.notEqual(replacement.json.code, pending.json.code);
  assert.notEqual(replacement.cookie, approvedCookie);
  assert.equal((await s.request("/auth?role=view", { cookie: approvedCookie })).status, 403);
  assert.equal(JSON.stringify(list.json).includes(approvedCookie.split("=")[1]), false,
    "owner listings do not disclose viewer private tokens");
});
