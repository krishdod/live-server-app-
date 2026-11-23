"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

test("the updated mail library delivers an owner-authorized invitation through a local SMTP fixture", { timeout: 15000 }, async t => {
  let message = "";
  const sockets = new Set();
  const smtp = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 localhost test SMTP\r\n");
    let input = "", data = false;
    socket.on("data", chunk => {
      input += chunk;
      let end;
      while ((end = input.indexOf("\r\n")) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (data) {
          if (line === ".") { data = false; socket.write("250 queued locally\r\n"); }
          else message += line + "\n";
        } else if (/^EHLO /i.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH /i.test(line)) socket.write("235 authenticated\r\n");
        else if (line === "DATA") { data = true; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") socket.end("221 goodbye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); smtp.close(); });
  smtp.listen(0, "127.0.0.1");
  await once(smtp, "listening");
  const child = spawn(process.execPath, [path.join(__dirname, "../server.js")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", RENDER: "", NODE_ENV: "test", APP_ORIGIN: "", APP_PASSWORD: "",
      EDIT_KEY: "mail-fixture-owner", VIEW_KEY: "", STREAM_KEY: "mail-fixture-stream", VIEWER_APPROVAL_REQUIRED: "true",
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.address().port), SMTP_USER: "test", SMTP_PASS: "test", EMAIL_FROM: "owner@example.test" }
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Mail fixture server exited ${code}`)));
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/Server running on port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/send-invite`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "edit", key: "mail-fixture-owner", email: "viewer@example.test", linkRole: "view" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.match(message, /To: viewer@example\.test/);
  assert.match(message, /Request access from the owner/);
  assert.equal(message.includes("mail-fixture-owner"), false);
  assert.equal(message.includes("mail-fixture-stream"), false);
});
