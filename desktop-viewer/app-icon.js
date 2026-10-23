"use strict";

// Controls normal taskbar/Dock presentation only. The OS process stays listed.
function createAppIcon(win, app, platform, options = {}) {
  const now = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  let visible = true;
  let wantedVisible = true;
  let lastDockHide = -Infinity;
  let timer = null;
  let disposed = false;

  function changed(value) {
    visible = value;
    options.onChange?.();
  }
  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function hideDock() {
    clearTimer();
    if (disposed || wantedVisible) return;
    // Electron documents a Dock.hide cooldown. A delayed hide must never
    // override a later request to show a login or revoked-access screen.
    const remaining = Math.max(0, 1100 - (now() - lastDockHide));
    if (remaining > 0) {
      timer = schedule(hideDock, remaining);
      return;
    }
    try {
      app.dock.hide();
      lastDockHide = now();
      changed(false);
    } catch { options.onError?.(); }
  }
  function setVisible(value) {
    if (disposed) return;
    wantedVisible = value === true;
    clearTimer();
    if (platform !== "darwin" || !app.dock) {
      try { win.setSkipTaskbar(!wantedVisible); changed(wantedVisible); }
      catch { options.onError?.(); }
      return;
    }
    if (!wantedVisible) { hideDock(); return; }
    try {
      Promise.resolve(app.dock.show()).then(() => {
        if (disposed) return;
        if (wantedVisible) changed(true);
        else hideDock();
      }).catch(() => { if (!disposed) options.onError?.(); });
    } catch { options.onError?.(); }
  }
  function dispose() { disposed = true; clearTimer(); }
  return { setVisible, isVisible: () => visible, dispose };
}

module.exports = { createAppIcon };
