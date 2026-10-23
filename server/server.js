const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const nodemailer = require("nodemailer");
const { ApprovalStore } = require("./approval");

const PORT = Number(process.env.PORT || 8765);
const viewerPath = path.join(__dirname, "viewer.html");

const STREAM_KEY = process.env.STREAM_KEY || "";
const EDIT_KEY = process.env.EDIT_KEY || "";
const VIEW_KEY = process.env.VIEW_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const APP_ORIGIN = String(process.env.APP_ORIGIN || "").replace(/\/$/, "");
const VIEWER_APPROVAL_REQUIRED = process.env.VIEWER_APPROVAL_REQUIRED !== "false";
const ACCESS_COOKIE = "lw_viewer_access";

if (VIEWER_APPROVAL_REQUIRED && !EDIT_KEY.trim()) {
  throw new Error("EDIT_KEY must be set before starting with viewer approval enabled.");
}
if (VIEWER_APPROVAL_REQUIRED && VIEW_KEY && safeEqualString(EDIT_KEY, VIEW_KEY)) {
  throw new Error("EDIT_KEY and VIEW_KEY must be different when viewer approval is enabled. Set a new owner-only EDIT_KEY.");
}
if (VIEWER_APPROVAL_REQUIRED && STREAM_KEY && safeEqualString(EDIT_KEY, STREAM_KEY)) {
  throw new Error("EDIT_KEY and STREAM_KEY must be different when viewer approval is enabled. Set a new owner-only EDIT_KEY.");
}
if (VIEWER_APPROVAL_REQUIRED && !APP_ORIGIN && (process.env.RENDER || process.env.NODE_ENV === "production")) {
  throw new Error("APP_ORIGIN must be set to the public HTTPS origin before starting hosted viewer approval.");
}
if (APP_ORIGIN) {
  const parsed = new URL(APP_ORIGIN);
  if (parsed.origin !== APP_ORIGIN || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("APP_ORIGIN must be an exact HTTP(S) origin without a path.");
  }
}

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER || "noreply@liveworkspace.app";

const GATE_TTL_MS = 24 * 60 * 60 * 1000;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const UNLOCK_MAX_ATTEMPTS = 10;
const MAX_SYNC_CHARS = 1_500_000;
const STREAM_COALESCE_MS = 80;

const gateTokens = new Map();
const unlockAttempts = new Map();

let mailer = null;
let lastAnswer = "";
let latestStreamAnswer = null;
let lastManualEdit = 0;
let autoCopyEnabled = true;
let clientCounter = 0;
let pendingStreamBroadcast = null;
let streamBroadcastTimer = null;
let enforcementQueued = false;
const approvals = new ApprovalStore({ onChange: () => {
  if (enforcementQueued) return;
  enforcementQueued = true;
  queueMicrotask(() => { enforcementQueued = false; enforceConnections(); });
} });

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

function passwordGateEnabled() {
  return Boolean(APP_PASSWORD);
}

function roleSecurityEnabled() {
  return Boolean(EDIT_KEY || VIEW_KEY);
}

function securityEnabled() {
  return Boolean(STREAM_KEY || EDIT_KEY || VIEW_KEY || APP_PASSWORD || VIEWER_APPROVAL_REQUIRED);
}

function isHostedRuntime() {
  return Boolean(process.env.RENDER || process.env.PORT || process.env.NODE_ENV === "production");
}

function safeEqualString(left, right) {
  const a = crypto.createHash("sha256").update(String(left ?? "")).digest();
  const b = crypto.createHash("sha256").update(String(right ?? "")).digest();
  return crypto.timingSafeEqual(a, b);
}

function checkAppPassword(password) {
  if (!passwordGateEnabled()) return true;
  return safeEqualString(password, APP_PASSWORD);
}

function issueGateToken() {
  sweepExpiredState();
  if (gateTokens.size >= 2000) return null;
  const token = crypto.randomBytes(24).toString("hex");
  gateTokens.set(token, Date.now() + GATE_TTL_MS);
  return token;
}

function validateGateToken(token) {
  if (!passwordGateEnabled()) return true;
  if (!token || typeof token !== "string") return false;
  const expiresAt = gateTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    gateTokens.delete(token);
    return false;
  }
  return true;
}

function normalizeRole(role) {
  return role === "view" ? "view" : "edit";
}

function requireGate(params, bodyToken) {
  if (!passwordGateEnabled()) return true;
  const role = normalizeRole(params.get("role"));
  // Owner credentials always need the owner's password, even in read-only mode.
  const isOwner = Boolean(EDIT_KEY && safeEqualString(params.get("key"), EDIT_KEY));
  if (role === "view" && !isOwner) return true;
  return validateGateToken(params.get("gate") || bodyToken || "");
}

function gateParamsFrom(role, key, gate) {
  const params = new URLSearchParams();
  params.set("role", normalizeRole(role));
  if (typeof key === "string") params.set("key", key);
  if (typeof gate === "string" && gate) params.set("gate", gate);
  return params;
}

function validateRole(role, key) {
  const normalized = normalizeRole(role);
  const provided = typeof key === "string" ? key : "";

  if (!roleSecurityEnabled()) {
    return { ok: true, role: normalized };
  }

  if (normalized === "edit" && EDIT_KEY && safeEqualString(provided, EDIT_KEY)) {
    return { ok: true, role: "edit" };
  }

  if (normalized === "view" && VIEW_KEY && safeEqualString(provided, VIEW_KEY)) {
    return { ok: !VIEWER_APPROVAL_REQUIRED, role: VIEWER_APPROVAL_REQUIRED ? null : "view" };
  }

  // Edit-key holders may open as view.
  if (normalized === "view" && EDIT_KEY && safeEqualString(provided, EDIT_KEY)) {
    return { ok: true, role: "view" };
  }

  return { ok: false, role: null };
}

function validateStreamKey(key) {
  if (!STREAM_KEY) {
    // Fail closed when hosted so a missing env var cannot leave ingest open.
    return !isHostedRuntime();
  }
  return safeEqualString(key, STREAM_KEY);
}

function clientIp(req) {
  // Only use the nearest proxy entry on Render; arbitrary client-supplied
  // forwarded addresses must not bypass the local request limit.
  const forwarded = process.env.RENDER
    ? String(req.headers["x-forwarded-for"] || "").split(",").at(-1).trim()
    : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

function allowUnlockAttempt(ip) {
  const now = Date.now();
  let row = unlockAttempts.get(ip);
  if (!row || now > row.resetAt) {
    sweepExpiredState();
    if (!row && unlockAttempts.size >= 2000) return false;
    row = { count: 0, resetAt: now + UNLOCK_WINDOW_MS };
  }
  row.count += 1;
  unlockAttempts.set(ip, row);
  return row.count <= UNLOCK_MAX_ATTEMPTS;
}

function sweepExpiredState() {
  const now = Date.now();
  for (const [token, expiresAt] of gateTokens) {
    if (now > expiresAt) gateTokens.delete(token);
  }
  for (const [ip, row] of unlockAttempts) {
    if (now > row.resetAt) unlockAttempts.delete(ip);
  }
}

function expectedOrigin(req) {
  if (APP_ORIGIN) return APP_ORIGIN;
  if (process.env.RENDER || process.env.NODE_ENV === "production") return "";
  // Hosted deployments must explicitly pin their public origin. Inferring it
  // from an untrusted Host header would allow hostile sites to submit actions.
  const host = String(req.headers.host || "");
  try {
    const url = new URL(`http://${host}`);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username && !url.password && url.host === host) return url.origin;
  } catch {}
  return "";
}

function sameOrigin(req) {
  const origin = expectedOrigin(req);
  return Boolean(origin && req.headers.origin === origin && req.headers["sec-fetch-site"] !== "cross-site");
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function accessToken(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  const cookie = cookies.find((entry) => entry.trim().startsWith(`${ACCESS_COOKIE}=`));
  return cookie ? cookie.trim().slice(ACCESS_COOKIE.length + 1) : "";
}

function setAccessCookie(req, res, token) {
  const secure = expectedOrigin(req).startsWith("https:");
  res.setHeader("Set-Cookie", `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 90000 : 0}${secure ? "; Secure" : ""}`);
}

function accessStatus(req) {
  const row = approvals.byToken(accessToken(req));
  const { id, createdAt, ...status } = approvals.publicRecord(row);
  return { enabled: VIEWER_APPROVAL_REQUIRED, ...status };
}

function authorize(req, params) {
  const role = normalizeRole(params.get("role"));
  if (!requireGate(params)) return { ok: false, role: null, passwordRequired: true };
  const owner = EDIT_KEY && safeEqualString(params.get("key"), EDIT_KEY);
  if (owner) return { ok: true, role };
  if (role === "view" && VIEWER_APPROVAL_REQUIRED) {
    const row = approvals.byToken(accessToken(req));
    if (row?.status === "approved") return { ok: true, role: "view", approvalId: row.id };
    return { ok: false, role: null, approvalRequired: true };
  }
  return validateRole(role, params.get("key"));
}

function authorizeAdmin(req) {
  if (!EDIT_KEY || !safeEqualString(req.headers["x-owner-key"], EDIT_KEY)) return false;
  return validateGateToken(req.headers["x-owner-gate"] || "");
}

async function accessApi(req, res, pathname) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "POST" && !sameOrigin(req)) {
    json(res, 403, { error: "Request must come from this workspace. Configure APP_ORIGIN for hosted access." });
    return;
  }
  if (pathname === "/api/access/status" && req.method === "GET") {
    json(res, 200, accessStatus(req)); return;
  }
  if (pathname === "/api/access/admin") {
    if (!authorizeAdmin(req)) {
      json(res, 403, { error: "Owner access required" }); return;
    }
    if (req.method === "GET") { json(res, 200, { requests: approvals.list() }); return; }
    if (req.method === "POST") {
      const parsed = JSON.parse(await readBody(req, 4096) || "{}");
      if (!parsed || typeof parsed.id !== "string" || !["approve", "reject", "revoke"].includes(parsed.action) ||
          (parsed.action === "approve" && !["hour", "day"].includes(parsed.duration))) {
        json(res, 400, { error: "Invalid access action" }); return;
      }
      const result = approvals.change(parsed.id, parsed.action, parsed.duration);
      json(res, result.status, result.error ? { error: result.error } : { ok: true, request: approvals.publicRecord(result.row) });
      return;
    }
  }
  if (pathname === "/api/access/request" && req.method === "POST") {
    if (!VIEWER_APPROVAL_REQUIRED) { json(res, 200, { enabled: false, status: "none" }); return; }
    if (!approvals.allowAttempt(clientIp(req))) {
      res.setHeader("Retry-After", "900");
      json(res, 429, { error: "Too many access requests. Try again in 15 minutes." }); return;
    }
    const parsed = JSON.parse(await readBody(req, 4096) || "{}");
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
      json(res, 400, { error: "Enter a name of 1 to 80 characters." }); return;
    }
    const created = approvals.create(name, accessToken(req));
    if (created.token) setAccessCookie(req, res, created.token);
    const { id, createdAt, ...status } = approvals.publicRecord(created.row);
    json(res, 200, { enabled: true, ...status }); return;
  }
  if (pathname === "/api/access/end" && req.method === "POST") {
    approvals.end(accessToken(req));
    setAccessCookie(req, res, "");
    json(res, 200, { enabled: VIEWER_APPROVAL_REQUIRED, status: "none" }); return;
  }
  json(res, 404, { error: "Not found" });
}

const CORS_ALLOWLIST = new Set(
  [
    APP_ORIGIN,
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://www.perplexity.ai",
    "https://perplexity.ai",
    "http://localhost:8765",
    "http://127.0.0.1:8765"
  ].filter(Boolean)
);

function setCorsHeaders(res, req) {
  const origin = req.headers.origin || "";
  if (origin && CORS_ALLOWLIST.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function publicBase(req) {
  if (APP_ORIGIN) return APP_ORIGIN;
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`;
}

function parseQuery(url) {
  const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  return new URLSearchParams(query);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (oversized) return;
      if (size > limit) {
        oversized = true;
        chunks = [];
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!oversized) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

async function sendInviteEmail(to, role, link) {
  const roleLabel = role === "edit" ? "Editor" : "Viewer";
  const subject = "You've been invited to Live Workspace";
  const text =
    `You've been invited to collaborate on Live Workspace as ${roleLabel}.\n\n` +
    `Open this link:\n${link}\n\n` +
    (role === "view" && VIEWER_APPROVAL_REQUIRED
      ? "Request access from the owner after opening this link."
      : `Anyone with this link can ${role === "edit" ? "edit" : "view"} the workspace.`);

  const html =
    `<p>You've been invited to collaborate on <strong>Live Workspace</strong> as <strong>${roleLabel}</strong>.</p>` +
    `<p><a href="${link}">Open Live Workspace</a></p>` +
    `<p style="color:#666;font-size:13px">Or copy this link:<br>${link}</p>`;

  await mailer.sendMail({ from: EMAIL_FROM, to, subject, text, html });
}

let viewerHtml = "";
try {
  viewerHtml = fs.readFileSync(viewerPath, "utf8");
} catch (err) {
  console.error("Failed to load viewer.html", err);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  const pathname = String(req.url || "").split("?")[0];
  if (pathname.startsWith("/api/access/")) {
    try {
      await accessApi(req, res, pathname);
    } catch (error) {
      const tooLarge = String(error.message).includes("Body too large");
      json(res, error.status || (tooLarge ? 413 : 400), { error: tooLarge ? "Payload too large" : (error.status ? error.message : "Invalid request") });
    }
    return;
  }
  setCorsHeaders(res, req);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") {
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const staticFiles = {
    "/vendor/marked.umd.js": ["vendor/marked.umd.js", "text/javascript"],
    "/vendor/purify.min.js": ["vendor/purify.min.js", "text/javascript"],
    "/markdown.js": ["markdown.js", "text/javascript"],
    "/access": ["access.html", "text/html"],
    "/access-admin": ["access-admin.html", "text/html"],
    "/access.js": ["access.js", "text/javascript"],
    "/access-admin.js": ["access-admin.js", "text/javascript"],
    "/access.css": ["access.css", "text/css"],
    "/workspace.css": ["workspace.css", "text/css"]
  };
  if (req.method === "GET" && Object.hasOwn(staticFiles, pathname)) {
    try {
      const [filename, type] = staticFiles[pathname];
      const content = fs.readFileSync(path.join(__dirname, filename));
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
      res.end(content);
    } catch {
      res.writeHead(404); res.end("File missing");
    }
    return;
  }

  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      secured: securityEnabled(),
      roleSecured: roleSecurityEnabled(),
      passwordGate: passwordGateEnabled(),
      approvalRequired: VIEWER_APPROVAL_REQUIRED,
      autoCopyEnabled,
      clients: wss?.clients?.size || 0
    }));
    return;
  }

  if (pathname === "/api/gate" && req.method === "GET") {
    const params = parseQuery(req.url);
    const role = normalizeRole(params.get("role"));
    const owner = EDIT_KEY && safeEqualString(params.get("key"), EDIT_KEY);
    const required = passwordGateEnabled() && (role === "edit" || Boolean(owner));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ required, role }));
    return;
  }

  if (pathname === "/api/unlock" && req.method === "POST") {
    try {
      const ip = clientIp(req);
      if (!allowUnlockAttempt(ip)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Too many attempts. Try again later." }));
        return;
      }

      const body = await readBody(req, 8_192);
      const parsed = JSON.parse(body || "{}");
      const password = typeof parsed.password === "string" ? parsed.password : "";

      if (!passwordGateEnabled()) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, required: false, token: "" }));
        return;
      }

      if (!checkAppPassword(password)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Wrong password" }));
        return;
      }

      const token = issueGateToken();
      if (!token) { json(res, 503, { ok: false, error: "Please try again later" }); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, required: true, token }));
    } catch (err) {
      if (String(err.message || err).includes("Body too large")) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Bad JSON" }));
    }
    return;
  }

  if (pathname === "/" || pathname === "/viewer") {
    if (!viewerHtml) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("viewer.html missing");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(viewerHtml);
    return;
  }

  if (pathname === "/api/share-links" && req.method === "GET") {
    const params = parseQuery(req.url);
    if (!requireGate(params)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Password required" }));
      return;
    }

    const auth = validateRole(params.get("role"), params.get("key"));
    if (!auth.ok || auth.role !== "edit") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const base = publicBase(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      viewLink: VIEWER_APPROVAL_REQUIRED ? `${base}/access` : roleSecurityEnabled()
        ? `${base}/?role=view&key=${encodeURIComponent(VIEW_KEY || EDIT_KEY)}`
        : `${base}/?role=view`,
      editLink: roleSecurityEnabled()
        ? `${base}/?role=edit&key=${encodeURIComponent(EDIT_KEY)}`
        : `${base}/?role=edit`,
      secured: roleSecurityEnabled()
    }));
    return;
  }

  if (pathname === "/api/send-invite" && req.method === "POST") {
    try {
      const body = await readBody(req, 32_768);
      const parsed = JSON.parse(body || "{}");
      const gate = typeof parsed.gate === "string" ? parsed.gate : "";
      const params = gateParamsFrom(parsed.role, parsed.key, gate);

      if (!requireGate(params, gate)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Password required" }));
        return;
      }

      const auth = validateRole(parsed.role, parsed.key);
      if (!auth.ok || auth.role !== "edit") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
      const linkRole = parsed.linkRole === "edit" ? "edit" : "view";

      if (!isValidEmail(email)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid email" }));
        return;
      }

      const base = publicBase(req);
      const link =
        linkRole === "edit"
          ? `${base}/?role=edit&key=${encodeURIComponent(EDIT_KEY)}`
          : VIEWER_APPROVAL_REQUIRED ? `${base}/access`
          : `${base}/?role=view&key=${encodeURIComponent(VIEW_KEY || EDIT_KEY)}`;

      if (!mailer) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Email not configured",
          mailto: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Live Workspace invite")}&body=${encodeURIComponent(`Open this link:\n${link}`)}`
        }));
        return;
      }

      await sendInviteEmail(email, linkRole, link);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (String(err.message || err).includes("Body too large")) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to send email" }));
    }
    return;
  }

  if (pathname === "/api/sync" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body || "{}");
      const gate = typeof parsed.gate === "string" ? parsed.gate : "";
      const params = gateParamsFrom(parsed.role, parsed.key, gate);

      if (!requireGate(params, gate)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Password required" }));
        return;
      }

      const auth = validateRole(parsed.role, parsed.key);
      if (!auth.ok || auth.role !== "edit") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      const text = typeof parsed.text === "string" ? parsed.text : null;
      if (text !== null) {
        if (text.length > MAX_SYNC_CHARS) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
          return;
        }
        lastManualEdit = Date.now();
        cancelPendingStreamBroadcast();
        lastAnswer = text;
        broadcast({ type: "sync", text, from: "edit", ts: lastManualEdit }, null);
      }

      res.writeHead(204);
      res.end();
    } catch (err) {
      if (String(err.message || err).includes("Body too large")) {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Payload too large");
        return;
      }
      res.writeHead(400);
      res.end();
    }
    return;
  }

  if (pathname === "/auth" && req.method === "GET") {
    const params = parseQuery(req.url);
    const result = authorize(req, params);
    json(res, result.ok ? 200 : result.passwordRequired ? 401 : 403, {
      ok: result.ok,
      role: result.role,
      secured: roleSecurityEnabled(),
      approvalEnabled: VIEWER_APPROVAL_REQUIRED,
      ...(result.passwordRequired ? { passwordRequired: true } : {}),
      ...(result.approvalRequired ? { approvalRequired: true } : {})
    });
    return;
  }

  if (pathname === "/answer" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body || "{}");
      const text = typeof parsed.text === "string" ? parsed.text : null;
      const key = typeof parsed.key === "string" ? parsed.key : "";

      if (!validateStreamKey(key)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      if (text !== null) {
        if (text.length > MAX_SYNC_CHARS) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload too large");
          return;
        }

        latestStreamAnswer = text;
        const now = Date.now();
        console.log(
          `[Live Workspace] /answer ${text.length} chars → ${wss?.clients?.size || 0} client(s), autoCopy=${autoCopyEnabled}`
        );

        if (autoCopyEnabled) {
          lastAnswer = text;
          scheduleStreamBroadcast(text, now);
        }
      }

      res.writeHead(204);
      res.end();
    } catch (err) {
      if (String(err.message || err).includes("Body too large")) {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Payload too large");
        return;
      }
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad JSON");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_SYNC_CHARS
});

function broadcast(msg, sender) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (!connectionAuthorized(client)) {
      client.close(1008, "Access expired or revoked");
      return;
    }
    if ((sender == null || client !== sender) && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function connectionAuthorized(ws) {
  if (!ws.authenticated) return false;
  if (ws.approvalId) return approvals.isApproved(ws.approvalId);
  return !ws.needsGate || validateGateToken(ws.gateToken);
}

function enforceConnections() {
  // All sockets are checked on every broadcast, on state changes, and on the
  // periodic expiry sweep. Unauthenticated sockets never receive stream data.
  for (const socket of wss.clients) {
    if (!connectionAuthorized(socket)) socket.close(1008, "Access expired or revoked");
  }
}

function scheduleStreamBroadcast(text, ts) {
  pendingStreamBroadcast = { text, ts };
  if (streamBroadcastTimer) return;
  streamBroadcastTimer = setTimeout(() => {
    streamBroadcastTimer = null;
    const pending = pendingStreamBroadcast;
    pendingStreamBroadcast = null;
    if (!pending || !autoCopyEnabled) return;
    broadcast({ type: "sync", text: pending.text, from: "stream", ts: pending.ts }, null);
  }, STREAM_COALESCE_MS);
}

function cancelPendingStreamBroadcast() {
  pendingStreamBroadcast = null;
  if (streamBroadcastTimer) clearTimeout(streamBroadcastTimer);
  streamBroadcastTimer = null;
}

wss.on("connection", (ws, req) => {
  const params = parseQuery(req.url || "");
  if (req.headers.origin && req.headers.origin !== expectedOrigin(req)) {
    ws.close(1008, "Origin not allowed");
    return;
  }
  const auth = authorize(req, params);
  if (!auth.ok) {
    ws.close(1008, auth.passwordRequired ? "Password required" : "Approval required");
    return;
  }

  ws.authenticated = true;
  ws.role = auth.role;
  ws.approvalId = auth.approvalId || null;
  ws.needsGate = passwordGateEnabled() && !ws.approvalId &&
    (auth.role === "edit" || Boolean(EDIT_KEY && safeEqualString(params.get("key"), EDIT_KEY)));
  ws.gateToken = params.get("gate") || "";
  ws.clientId = `c${++clientCounter}`;

  ws.send(JSON.stringify({ type: "auth", role: auth.role, clientId: ws.clientId }));
  ws.send(JSON.stringify({ type: "autoCopy", on: autoCopyEnabled }));

  ws.send(JSON.stringify({ type: "sync", text: lastAnswer, from: "server" }));

  ws.on("message", (raw) => {
    if (!connectionAuthorized(ws)) {
      ws.close(1008, "Access expired or revoked");
      return;
    }
    if (ws.role !== "edit") return;

    try {
      const msg = JSON.parse(String(raw));

      if (msg.type === "sync" && typeof msg.text === "string") {
        if (msg.text.length > MAX_SYNC_CHARS) return;
        cancelPendingStreamBroadcast();
        lastAnswer = msg.text;
        msg.clientId = ws.clientId;
        if (msg.from !== "stream") {
          lastManualEdit = Date.now();
        }
        broadcast(msg, ws);
      }

      if (msg.type === "selection" && typeof msg.start === "number") {
        msg.clientId = ws.clientId;
        broadcast(msg, ws);
      }

      if (msg.type === "autoCopy" && typeof msg.on === "boolean") {
        const wasEnabled = autoCopyEnabled;
        autoCopyEnabled = msg.on;
        broadcast({ type: "autoCopy", on: autoCopyEnabled }, null);
        if (autoCopyEnabled && !wasEnabled && latestStreamAnswer !== null) {
          lastAnswer = latestStreamAnswer;
          cancelPendingStreamBroadcast();
          broadcast({ type: "sync", text: lastAnswer, from: "stream", ts: Date.now() }, null);
        }
      }
    } catch {
      // ignore malformed messages
    }
  });
});

setInterval(() => {
  sweepExpiredState();
  approvals.sweep();
  enforceConnections();
}, 1000).unref?.();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${server.address().port}`);
  if (STREAM_KEY) console.log("Stream key: enabled");
  if (roleSecurityEnabled()) console.log("Role access control: enabled");
  if (passwordGateEnabled()) console.log("App password gate: enabled");
  if (VIEWER_APPROVAL_REQUIRED) console.log("Viewer approval: required");
  if (APP_ORIGIN) console.log(`App origin pinned: ${APP_ORIGIN}`);
  if (isHostedRuntime() && !STREAM_KEY) {
    console.warn("WARNING: STREAM_KEY is unset on a hosted runtime — /answer is fail-closed");
  }
});

