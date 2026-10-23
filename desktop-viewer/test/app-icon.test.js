"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppIcon } = require("../app-icon");

function dockHarness() {
  let time = 0, next = 0, dockVisible = true;
  const timers = new Map(), calls = [];
  const app = { dock: {
    hide() { calls.push(["hide", time]); dockVisible = false; },
    show() { calls.push(["show", time]); dockVisible = true; return Promise.resolve(); },
    isVisible: () => dockVisible
  } };
  const icon = createAppIcon({}, app, "darwin", {
    now: () => time,
    setTimeout(callback, delay) { timers.set(++next, { callback, at: time + delay }); return next; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { icon, calls, timers, visible: () => dockVisible,
    advance(ms) { time += ms; for (const [id, item] of [...timers]) if (item.at <= time) { timers.delete(id); item.callback(); } }
  };
}

test("Windows icon visibility changes only taskbar membership", () => {
  const calls = [];
  const icon = createAppIcon({ setSkipTaskbar: value => calls.push(value) }, {}, "win32");
  icon.setVisible(false);
  assert.equal(icon.isVisible(), false);
  icon.setVisible(true);
  assert.equal(icon.isVisible(), true);
  assert.deepEqual(calls, [true, false]);
});

test("Mac Dock visibility uses its native API and respects the hide cooldown", async () => {
  const h = dockHarness();
  h.icon.setVisible(false);
  assert.equal(h.visible(), false);
  h.icon.setVisible(true);
  await Promise.resolve();
  assert.equal(h.visible(), true);
  h.icon.setVisible(false);
  assert.equal(h.calls.filter(call => call[0] === "hide").length, 1);
  h.advance(1099);
  assert.equal(h.visible(), true);
  h.advance(1);
  assert.equal(h.visible(), false);
  assert.deepEqual(h.calls.filter(call => call[0] === "hide"), [["hide", 0], ["hide", 1100]]);
  h.icon.dispose();
});

test("a delayed Dock hide cannot hide a later approval screen", async () => {
  const h = dockHarness();
  h.icon.setVisible(false);
  h.icon.setVisible(true);
  h.icon.setVisible(false);
  h.icon.setVisible(true);
  await Promise.resolve();
  h.advance(2000);
  assert.equal(h.visible(), true);
  assert.equal(h.icon.isVisible(), true);
  assert.equal(h.calls.filter(call => call[0] === "hide").length, 1);
  h.icon.dispose();
});

test("closing the controller cancels deferred Dock changes", async () => {
  const h = dockHarness();
  h.icon.setVisible(false);
  h.icon.setVisible(true);
  h.icon.setVisible(false);
  h.icon.dispose();
  await Promise.resolve();
  h.advance(2000);
  assert.equal(h.visible(), true);
  assert.equal(h.timers.size, 0);
});
