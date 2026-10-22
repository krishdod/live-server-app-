const crypto = require("node:crypto");

const PENDING_TTL_MS = 20 * 60 * 1000;
const TERMINAL_TTL_MS = 30 * 60 * 1000;
const DURATIONS = Object.freeze({ hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 });

function digest(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

class ApprovalStore {
  constructor({ now = Date.now, maxRequests = 2000, maxRateEntries = 2000, onChange = () => {} } = {}) {
    this.now = now;
    this.maxRequests = maxRequests;
    this.maxRateEntries = maxRateEntries;
    this.onChange = onChange;
    this.requests = new Map();
    this.tokens = new Map();
    this.attempts = new Map();
  }

  publicRecord(row) {
    if (!row) return { status: "none" };
    return {
      id: row.id, code: row.code, name: row.name, status: row.status,
      createdAt: row.createdAt, pendingExpiresAt: row.pendingExpiresAt,
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {})
    };
  }

  expire(row) {
    const now = this.now();
    if ((row.status === "pending" && now >= row.pendingExpiresAt) ||
        (row.status === "approved" && now >= row.expiresAt)) {
      row.status = "expired";
      row.terminalAt = now;
      this.onChange(row.id);
    }
    return row;
  }

  sweep() {
    for (const [id, row] of this.requests) {
      this.expire(row);
      if (row.terminalAt !== undefined && this.now() >= row.terminalAt + TERMINAL_TTL_MS) {
        this.requests.delete(id);
        this.tokens.delete(row.tokenHash);
      }
    }
    for (const [key, row] of this.attempts) {
      if (this.now() >= row.resetAt) this.attempts.delete(key);
    }
  }

  allowAttempt(identity) {
    this.sweep();
    let row = this.attempts.get(identity);
    if (!row) {
      if (this.attempts.size >= this.maxRateEntries) return false;
      row = { count: 0, resetAt: this.now() + 15 * 60 * 1000 };
      this.attempts.set(identity, row);
    }
    row.count += 1;
    return row.count <= 10;
  }

  byToken(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const id = this.tokens.get(digest(token));
    const row = this.requests.get(id);
    return row ? this.expire(row) : null;
  }

  isApproved(id) {
    const row = this.requests.get(id);
    return Boolean(row && this.expire(row).status === "approved");
  }

  create(name, token) {
    this.sweep();
    const existing = this.byToken(token);
    if (existing && (existing.status === "pending" || existing.status === "approved")) {
      return { row: existing, token: null };
    }
    if (this.requests.size >= this.maxRequests) {
      const error = new Error("Too many access requests. Try again later.");
      error.status = 503;
      throw error;
    }
    const privateToken = crypto.randomBytes(32).toString("hex");
    const id = crypto.randomBytes(16).toString("hex");
    let code;
    const codes = new Set([...this.requests.values()].map((row) => row.code));
    do {
      code = crypto.randomBytes(4).toString("hex").toUpperCase();
      code = `${code.slice(0, 4)}-${code.slice(4)}`;
    } while (codes.has(code));
    const now = this.now();
    const row = {
      id, code, name, status: "pending", createdAt: now,
      pendingExpiresAt: now + PENDING_TTL_MS, tokenHash: digest(privateToken)
    };
    this.requests.set(id, row);
    this.tokens.set(row.tokenHash, id);
    return { row, token: privateToken };
  }

  change(id, action, duration) {
    const row = this.requests.get(id);
    if (!row) return { status: 404, error: "Request not found" };
    this.expire(row);
    if (action === "approve" && row.status === "pending" && Object.hasOwn(DURATIONS, duration)) {
      row.status = "approved";
      row.expiresAt = this.now() + DURATIONS[duration];
    } else if (action === "reject" && row.status === "pending") {
      row.status = "rejected";
      row.terminalAt = this.now();
    } else if (action === "revoke" && row.status === "approved") {
      row.status = "revoked";
      row.terminalAt = this.now();
    } else {
      return { status: 409, error: "This request has changed. Refresh and try again." };
    }
    this.onChange(id);
    return { status: 200, row };
  }

  end(token) {
    const row = this.byToken(token);
    if (!row) return;
    if (row.status === "pending" || row.status === "approved") {
      row.status = "revoked";
      row.terminalAt = this.now();
      this.onChange(row.id);
    }
  }

  list() {
    this.sweep();
    return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => this.publicRecord(row));
  }
}

module.exports = { ApprovalStore, PENDING_TTL_MS, TERMINAL_TTL_MS, DURATIONS };
