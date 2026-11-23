const crypto = require("node:crypto");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const TTL = 2 * 60 * 60 * 1000;
const PAIR_TTL = 10 * 60 * 1000;

// A sender capability can only append text to its own session. It has no
// workspace read/edit privileges and is never accepted by the answer relay.
class TranscriptStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sessions = new Map();
    this.attempts = new Map();
  }
  sweep() {
    for (const [id, row] of this.sessions) if (this.now() >= row.expiresAt) this.sessions.delete(id);
    for (const [id, row] of this.attempts) if (this.now() >= row.until) this.attempts.delete(id);
  }
  public(row) {
    return { id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt,
      paired: Boolean(row.tokenHash), sender: row.sender, lastSeen: row.lastSeen,
      state: row.state, pairCode: row.tokenHash || this.now() >= row.pairExpiresAt ? "" : row.code,
      pairExpiresAt: row.pairExpiresAt };
  }
  list() { this.sweep(); return [...this.sessions.values()].map(row => this.public(row)); }
  create() {
    this.sweep();
    if (this.sessions.size >= 20) fail(409, "End an existing transcript session first.");
    const id = crypto.randomBytes(16).toString("hex");
    const row = { id, code: crypto.randomBytes(6).toString("hex").toUpperCase().match(/.{4}/g).join("-"),
      createdAt: this.now(), expiresAt: this.now() + TTL, pairExpiresAt: this.now() + PAIR_TTL,
      tokenHash: "", sender: "", state: "waiting", lastSeen: null, sequence: 0, packetHash: "",
      version: 0, turns: [], draft: "", names: {}, chars: 0 };
    this.sessions.set(id, row);
    return this.public(row);
  }
  get(id) { this.sweep(); const row = this.sessions.get(id); if (!row) fail(404, "Session ended or expired. Create a new session."); return row; }
  pair(code, name, identity) {
    this.sweep();
    let attempt = this.attempts.get(identity);
    if (!attempt) {
      if (this.attempts.size >= 2000) fail(429, "Pairing is busy. Try later.");
      attempt = { count: 0, until: this.now() + 15 * 60 * 1000 }; this.attempts.set(identity, attempt);
    }
    if (++attempt.count > 10) fail(429, "Too many pairing attempts. Try in 15 minutes.");
    if (typeof code !== "string" || typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) fail(400, "Enter a pairing code and a name (up to 80 characters).");
    const normalized = code.replace(/[^a-f0-9]/gi, "").toUpperCase();
    const row = [...this.sessions.values()].find(row => row.code.replaceAll("-", "") === normalized && !row.tokenHash && this.now() < row.pairExpiresAt);
    if (!row) fail(403, "Pairing code is invalid, used or expired. Ask the helper for a new code.");
    const token = crypto.randomBytes(32).toString("hex");
    row.tokenHash = hash(token); row.sender = name.trim(); row.state = "ready"; row.lastSeen = this.now();
    return { token, session: row.id, expiresAt: row.expiresAt };
  }
  ingest(token, packet) {
    this.sweep();
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) fail(403, "Sender access expired. Pair again.");
    const tokenHash = hash(token);
    const row = [...this.sessions.values()].find(row => row.tokenHash === tokenHash);
    if (!row) fail(403, "Sender access expired. Pair again.");
    if (!packet || typeof packet !== "object" || Array.isArray(packet) ||
        Object.keys(packet).some(key => !["seq", "type", "text", "speaker", "startedMs", "endedMs", "state"].includes(key)) ||
        !Number.isSafeInteger(packet.seq) || packet.seq < 1 || !["draft", "final", "status"].includes(packet.type)) fail(400, "Invalid transcript packet. Only transcript text is accepted.");
    const fingerprint = hash(JSON.stringify(packet));
    if (packet.seq === row.sequence && fingerprint === row.packetHash) return { ackSeq: row.sequence };
    if (packet.seq !== row.sequence + 1) fail(409, "Transcript sequence mismatch. Pair a new session.");
    if (packet.type === "status") {
      if (!["listening", "stopped"].includes(packet.state)) fail(400, "Invalid sender state.");
      row.state = packet.state;
      if (packet.state === "stopped") row.draft = "";
    } else {
      if (typeof packet.text !== "string" || packet.text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(packet.text)) fail(400, "Caption text must be at most 4000 characters.");
      if (packet.type === "final") {
        if (!packet.text.trim() || !/^(unknown|local|speaker-[1-8])$/.test(packet.speaker) ||
            !Number.isFinite(packet.startedMs) || !Number.isFinite(packet.endedMs) ||
            packet.startedMs < 0 || packet.endedMs < packet.startedMs || packet.endedMs > TTL) fail(400, "Invalid final caption.");
        const turn = { id: packet.seq, text: packet.text.trim(), speaker: packet.speaker,
          startedMs: packet.startedMs, endedMs: packet.endedMs, revision: row.version + 1 };
        row.turns.push(turn); row.chars += turn.text.length;
        while (row.turns.length > 300 || row.chars > 250000) row.chars -= row.turns.shift().text.length;
        row.draft = "";
      } else row.draft = packet.text;
      row.state = "listening";
    }
    row.sequence = packet.seq; row.packetHash = fingerprint; row.lastSeen = this.now(); row.version++;
    return { ackSeq: row.sequence };
  }
  snapshot(id, after = 0) {
    const row = this.get(id);
    return { ...this.public(row), version: row.version, names: row.names, draft: row.draft,
      firstTurn: row.turns[0]?.id || 0, turns: row.turns.filter(turn => turn.revision > after) };
  }
  rename(id, speaker, name) {
    const row = this.get(id);
    if (!/^(local|speaker-[1-8])$/.test(speaker) || typeof name !== "string" || name.trim().length > 60 || /[\x00-\x1f\x7f]/.test(name)) fail(400, "Enter a speaker name of up to 60 characters.");
    row.names[speaker] = name.trim(); row.version++;
  }
  assign(id, turnId, speaker) {
    const row = this.get(id);
    if (!Number.isSafeInteger(turnId) || !/^(unknown|local|speaker-[1-8])$/.test(speaker)) fail(400, "Choose a speaker for this phrase.");
    const turn = row.turns.find(turn => turn.id === turnId);
    if (!turn) fail(404, "This phrase is no longer retained.");
    turn.speaker = speaker; turn.revision = ++row.version;
  }
  end(id) { this.get(id); this.sessions.delete(id); }
}

module.exports = { TranscriptStore, TTL, PAIR_TTL };
