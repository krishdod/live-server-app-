const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const { test } = require("node:test");
const WebSocket = require("ws");

async function startRelay(t) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: "0",
      STREAM_KEY: "test-stream-key",
      EDIT_KEY: "test-edit-key",
      VIEW_KEY: "test-view-key",
      VIEWER_APPROVAL_REQUIRED: "false",
      APP_PASSWORD: "",
      APP_ORIGIN: "",
      NODE_ENV: "test",
      RENDER: "",
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASS: ""
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Relay startup timed out")), 5000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Server running on port (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Relay exited during startup (${code})`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const connect = async (role = "view") => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?role=${role}&key=test-${role}-key`);
    const messages = [];
    const listeners = new Set();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      messages.push(message);
      for (const listener of listeners) listener();
    });
    socket.on("error", () => {});
    t.after(() => socket.terminate());
    const next = (predicate) => new Promise((resolve, reject) => {
      const inspect = () => {
        const index = messages.findIndex(predicate);
        if (index < 0) return;
        clearTimeout(timeout);
        listeners.delete(inspect);
        resolve(messages.splice(index, 1)[0]);
      };
      const timeout = setTimeout(() => {
        listeners.delete(inspect);
        reject(new Error("Expected relay message was not received"));
      }, 3000);
      listeners.add(inspect);
      inspect();
    });
    await next((msg) => msg.type === "auth");
    return { socket, messages, next };
  };
  const postAnswer = (text, key = "test-stream-key") => fetch(`${base}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, key })
  });
  return { base, connect, postAnswer };
}

test("ingested answers reach connected viewers and viewers joining later", async (t) => {
  const relay = await startRelay(t);
  const viewer = await relay.connect();
  assert.equal((await viewer.next((msg) => msg.type === "autoCopy")).on, true);
  assert.equal((await relay.postAnswer("The ChatGPT answer")).status, 204);
  assert.equal((await viewer.next((msg) => msg.from === "stream")).text, "The ChatGPT answer");
  const later = await relay.connect();
  assert.equal((await later.next((msg) => msg.from === "server")).text, "The ChatGPT answer");
});

test("resuming sends the latest paused answer, even after manual edits", async (t) => {
  const relay = await startRelay(t);
  const editor = await relay.connect("edit");
  const viewer = await relay.connect();
  await relay.postAnswer("Initial answer");
  await viewer.next((msg) => msg.from === "stream");

  editor.socket.send(JSON.stringify({ type: "autoCopy", on: false }));
  await viewer.next((msg) => msg.type === "autoCopy" && msg.on === false);
  await editor.next((msg) => msg.type === "autoCopy" && msg.on === false);
  assert.equal((await (await fetch(`${relay.base}/health`)).json()).autoCopyEnabled, false);
  await relay.postAnswer("Partial next answer");
  await relay.postAnswer("Finished next answer");

  await fetch(`${relay.base}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "edit", key: "test-edit-key", text: "Manual workspace text" })
  });
  await viewer.next((msg) => msg.from === "edit");
  const later = await relay.connect();
  assert.equal((await later.next((msg) => msg.from === "server")).text, "Manual workspace text");
  assert.equal(viewer.messages.some((msg) => msg.from === "stream"), false);

  editor.socket.send(JSON.stringify({ type: "autoCopy", on: true }));
  await viewer.next((msg) => msg.type === "autoCopy" && msg.on === true);
  assert.equal((await (await fetch(`${relay.base}/health`)).json()).autoCopyEnabled, true);
  assert.equal((await viewer.next((msg) => msg.from === "stream")).text, "Finished next answer");
  assert.equal((await later.next((msg) => msg.from === "stream")).text, "Finished next answer");
  const afterResume = await relay.connect();
  assert.equal((await afterResume.next((msg) => msg.from === "server")).text, "Finished next answer");
});

test("empty answer snapshots clear the viewer on reconnect", async (t) => {
  const relay = await startRelay(t);
  await relay.postAnswer("Old response");
  await relay.postAnswer("");
  const viewer = await relay.connect();
  assert.equal((await viewer.next((msg) => msg.from === "server")).text, "");
});

test("a rejected stream key does not replace the latest answer", async (t) => {
  const relay = await startRelay(t);
  await relay.postAnswer("Accepted answer");
  assert.equal((await relay.postAnswer("Rejected answer", "wrong-key")).status, 403);
  const viewer = await relay.connect();
  assert.equal((await viewer.next((msg) => msg.from === "server")).text, "Accepted answer");
});

for (const mode of ["http", "websocket"]) {
  test(`a manual ${mode} edit cancels an older queued stream update`, async (t) => {
    const relay = await startRelay(t);
    const editor = await relay.connect("edit");
    const viewer = await relay.connect();
    await viewer.next((msg) => msg.from === "server");
    await relay.postAnswer("Older streamed answer");
    if (mode === "http") {
      assert.equal((await fetch(`${relay.base}/api/sync`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "edit", key: "test-edit-key", text: "Newer manual edit" })
      })).status, 204);
    } else {
      editor.socket.send(JSON.stringify({ type: "sync", from: "edit", text: "Newer manual edit" }));
    }
    assert.equal((await viewer.next((msg) => msg.from === "edit")).text, "Newer manual edit");
    // Discard any stream data already delivered before the manual edit. Nothing
    // older may subsequently overwrite that edit in connected viewers.
    viewer.messages.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(viewer.messages.some((msg) => msg.text === "Older streamed answer"), false);
    const reconnected = await relay.connect();
    assert.equal((await reconnected.next((msg) => msg.from === "server")).text, "Newer manual edit");
  });
}
