"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { describeOpenError } = require("../open-errors");
const { isToolbarFile, trustedToolbar } = require("../policy");

test("equivalent encoded local paths are accepted while other files and websites are rejected", () => {
  const home = path.join(__dirname, "../home.html");
  const url = pathToFileURL(home).href;
  assert.equal(isToolbarFile(url.replace("home.html", "h%6fme.html"), home), true);
  assert.equal(isToolbarFile(url + "?other=1", home), false);
  assert.equal(isToolbarFile(url.replace("home.html", "main.js"), home), false);
  assert.equal(isToolbarFile("https://example.com/home.html", home), false);
});

test("IPC accepts the actual main frame identity or its native IDs, never a subframe or remote renderer", () => {
  const home = path.join(__dirname, "../home.html");
  const frame = { url: pathToFileURL(home).href, processId: 123, routingId: 456 };
  const contents = { mainFrame: frame };
  assert.equal(trustedToolbar({ sender: contents, senderFrame: frame }, contents, home), true);
  assert.equal(trustedToolbar({ sender: contents, senderFrame: { ...frame } }, contents, home), true);
  assert.equal(trustedToolbar({ sender: contents, senderFrame: { ...frame, routingId: 789 } }, contents, home), false);
  assert.equal(trustedToolbar({ sender: {}, senderFrame: frame }, contents, home), false);
});

test("connection errors show specific safe guidance without leaking URLs, keys or file paths", () => {
  const failure = describeOpenError(new Error("net::ERR_TUNNEL_CONNECTION_FAILED at https://example.test/?key=private-key C:\\Users\\PrivateName\\file"), "load-page");
  assert.equal(failure.code, "ERR_TUNNEL_CONNECTION_FAILED");
  assert.match(failure.message, /proxy/);
  assert.equal(JSON.stringify(failure).includes("private-key"), false);
  assert.equal(JSON.stringify(failure).includes("PrivateName"), false);
  assert.equal(JSON.stringify(failure).includes("https://"), false);
  assert.match(describeOpenError({ code: "ERR_CERT_AUTHORITY_INVALID" }, "load-page").message, /certificates/);
  assert.equal(describeOpenError(new Error("private details"), "create-view").code, "APP_CREATE_VIEW");
});
