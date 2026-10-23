"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BACKGROUND_OPACITY = 0.75;
const GLASS_CSS = fs.readFileSync(path.join(__dirname, "glass.css"), "utf8");
const SOLID = "#10151d";
const CLEAR = "#00000000";

function createAppearance(win, platform, release) {
  let revision = 0;
  let activeSheet = null;
  const [major, , build] = String(release).split(".").map(Number);
  const acrylic = platform === "win32" && (major > 10 || (major === 10 && build >= 22621));

  function remove(sheet) {
    if (!sheet || sheet.wc.isDestroyed()) return;
    Promise.resolve(sheet.wc.removeInsertedCSS(sheet.key)).catch(() => {});
  }

  function apply(view, interactive, opacity) {
    const current = ++revision;
    // Native opacity would fade letters and code along with the background.
    win.setOpacity(1);
    const color = interactive ? SOLID : CLEAR;
    win.setBackgroundColor(color);
    if (view) view.setBackgroundColor(color);
    try {
      if (acrylic) win.setBackgroundMaterial(interactive ? "none" : "acrylic");
      if (platform === "darwin") win.setVibrancy(interactive ? null : "under-window");
    } catch { /* Plain alpha transparency remains available without native blur. */ }

    if (interactive || !view) {
      remove(activeSheet);
      activeSheet = null;
      return Promise.resolve(true);
    }

    const wc = view.webContents;
    const previous = activeSheet;
    const alpha = Math.min(1, Math.max(0.2, Number(opacity) || DEFAULT_BACKGROUND_OPACITY));
    return Promise.resolve().then(() => wc.insertCSS(GLASS_CSS.replaceAll("GLASS_ALPHA", String(alpha)), { cssOrigin: "user" }))
      .then(key => {
        const sheet = { wc, key };
        if (current !== revision || wc.isDestroyed()) { remove(sheet); return false; }
        activeSheet = sheet;
        remove(previous);
        return true;
      })
      .catch(() => {
        // A navigation can dispose the document while a style update is pending.
        if (current === revision && !wc.isDestroyed()) {
          win.setBackgroundColor(SOLID);
          view.setBackgroundColor(SOLID);
        }
        return false;
      });
  }

  function dispose() {
    revision++;
    remove(activeSheet);
    activeSheet = null;
  }

  return { apply, dispose };
}

module.exports = { createAppearance, DEFAULT_BACKGROUND_OPACITY };
