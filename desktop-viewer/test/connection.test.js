"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, networkCode } = require("../connection");

test("a stalled navigation times out and stops loading", async () => {
  let stopped = false;
  await assert.rejects(loadPage({ loadURL: () => new Promise(() => {}), stop() { stopped = true; } }, "https://example.test/access", 10), { code: "ERR_TIMED_OUT" });
  assert.equal(stopped, true);
});

test("network evidence extracts only a known-shaped code, never the raw error message", () => {
  assert.equal(networkCode("net::ERR_PROXY_CONNECTION_FAILED at private address"), "ERR_PROXY_CONNECTION_FAILED");
  assert.equal(networkCode("private information only"), null);
});
