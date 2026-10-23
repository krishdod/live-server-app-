"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
function popup(t, delivery) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8"), { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const calls = [];
  let saved = false;
  dom.window.chrome = { runtime: { sendMessage(message, callback) {
    calls.push(message);
    if (message.type === "save-connection") {
      saved = true;
      callback({ ok: true, keyConfigured: true, server: message.server });
    } else callback({ server: "https://live-server-app.onrender.com", keyConfigured: saved, health: { ok: true, clients: 1 }, delivery, queueSize: 0 });
  } } };
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8"));
  return { window: dom.window, el: id => dom.window.document.getElementById(id), calls };
}
test("the popup distinguishes an online server from a rejected publishing key", t => {
  const h = popup(t, { sent: false, status: 403, error: "Key rejected. Update Connection settings." });
  assert.equal(h.el("health").textContent, "Online");
  assert.match(h.el("delivery").textContent, /Key rejected/);
  assert.equal(h.el("settings").open, true);
});
test("saving connection settings clears the secret input and testing sends no answer", t => {
  const h = popup(t);
  h.el("serverInput").value = "https://live-server-app.onrender.com";
  h.el("keyInput").value = "fake-publishing-key";
  h.el("connectionForm").dispatchEvent(new h.window.Event("submit", { cancelable: true }));
  assert.equal(h.calls.find(message => message.type === "save-connection").key, "fake-publishing-key");
  assert.equal(h.el("keyInput").value, "");
  assert.match(h.el("settingsNotice").textContent, /Saved/);
  h.el("testBtn").click();
  assert.equal(h.calls.find(message => message.type === "test-delivery").text, undefined);
});
