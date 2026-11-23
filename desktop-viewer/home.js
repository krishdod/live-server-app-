"use strict";

const api = window.viewerApi;
const retryButton = document.getElementById("retry-connection");
const reloadButton = document.getElementById("reload");
const protectionLabel = document.getElementById("protection");
const statusMessage = document.getElementById("status-message");
const errorMessage = document.getElementById("open-error");
const errorPanel = document.getElementById("connection-error");
const hideButton = document.getElementById("hide");
const shortcutHint = document.getElementById("shortcut-hint");
const pinCheckbox = document.getElementById("pin");
const clickThroughCheckbox = document.getElementById("click-through");
const hideControlsButton = document.getElementById("hide-controls");
const showControlsButton = document.getElementById("show-controls");
const stripCloseButton = document.getElementById("strip-close");
const opacityLabel = document.getElementById("opacity-label");
const opacityUp = document.getElementById("opacity-up");
const opacityDown = document.getElementById("opacity-down");
const COMPACT_HEADER = 128;
const COLLAPSED_HEADER = 44;
let opening = false;
let currentStatus = null;
let lastPointerOverToolbar = true;
let errorDetails = null;

function showError(message, details = null) {
  const text = message || "The workspace could not connect. Choose Retry connection.";
  errorMessage.textContent = text;
  errorMessage.hidden = false;
  errorPanel.hidden = false;
  errorDetails = details;
  statusMessage.textContent = text;
  statusMessage.title = text;
  statusMessage.classList.add("error-message");
}

function headerLimit() {
  if (document.body.classList.contains("toolbar-hidden")) return COLLAPSED_HEADER;
  return COMPACT_HEADER;
}

function applyStatus(status) {
  const wasCollapsed = document.body.classList.contains("toolbar-hidden");
  const focusInPanel = document.querySelector(".toolbar").contains(document.activeElement);
  currentStatus = status || {};
  retryButton.disabled = reloadButton.disabled = Boolean(currentStatus.opening);
  retryButton.textContent = currentStatus.opening ? "Connecting…" : "Retry connection";
  document.querySelector('.welcome-content > h2').textContent = currentStatus.failure ? "Let’s reconnect." : "Connecting your workspace…";
  if (currentStatus.failure && !currentStatus.opening) showError(currentStatus.failure.message, currentStatus.failure.diagnostics);
  else {
    errorPanel.hidden = true;
    errorMessage.hidden = true;
    errorDetails = null;
    document.getElementById("copy-error").textContent = "Copy error details";
  }
  document.querySelector("h1 span").textContent = currentStatus.version ? `Viewer ${currentStatus.version}` : "Viewer";
  const protectedWindow = currentStatus.supported && currentStatus.protection;
  protectionLabel.textContent = protectedWindow ? "Capture protection on" : "Protection unavailable";
  protectionLabel.className = `protection ${protectedWindow ? "enabled" : "unavailable"}`;
  protectionLabel.title = protectedWindow
    ? "Capture exclusion is enabled. Verify it in your sharing app."
    : "This app cannot confirm capture protection on this system.";
  hideButton.disabled = !currentStatus.shortcut;
  hideButton.title = currentStatus.shortcut
    ? "Hide this window; Ctrl+Alt+V (Control+Option+V on Mac) brings it back"
    : "Hide is unavailable because the keyboard shortcut could not be registered";

  const parts = [];
  if (currentStatus.shortcut) parts.push("<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> show/hide");
  if (currentStatus.toolbarShortcut) parts.push("<kbd>B</kbd> controls");
  if (currentStatus.pinShortcut) parts.push("<kbd>T</kbd> pin");
  if (currentStatus.clickThroughShortcut) parts.push("<kbd>C</kbd> click-through");
  if (currentStatus.opacityUpShortcut || currentStatus.opacityDownShortcut) parts.push("<kbd>=</kbd>/<kbd>-</kbd> opacity");
  shortcutHint.hidden = parts.length === 0;
  shortcutHint.innerHTML = parts.slice(0, 2).join(" · ");

  pinCheckbox.checked = Boolean(currentStatus.pinned);
  clickThroughCheckbox.checked = Boolean(currentStatus.clickThrough);
  clickThroughCheckbox.disabled = Boolean(currentStatus.interactivePage);
  clickThroughCheckbox.title = currentStatus.interactivePage
    ? "Available after approval and sign-in. This page needs mouse input."
    : "Click apps behind the live viewer";

  const percent = Math.round((Number(currentStatus.opacity) || 1) * 100);
  opacityLabel.textContent = `BG ${percent}%`;
  opacityUp.disabled = Boolean(currentStatus.interactivePage) || percent >= 100;
  opacityDown.disabled = Boolean(currentStatus.interactivePage) || percent <= 20;

  document.body.classList.toggle("toolbar-hidden", Boolean(currentStatus.toolbarHidden));
  document.documentElement.classList.toggle("viewer-glass", currentStatus.interactivePage === false);
  hideControlsButton.hidden = currentStatus.interactivePage !== false;
  showControlsButton.setAttribute("aria-expanded", String(!currentStatus.toolbarHidden));
  const readyLabel = document.querySelector(".ready-label");
  readyLabel.textContent = currentStatus.connection === "connected" ? currentStatus.streamPaused ? "Paused" : "Connected" : "Reconnecting";
  readyLabel.classList.toggle("waiting", currentStatus.connection !== "connected" || currentStatus.streamPaused);
  readyLabel.title = currentStatus.streamPaused ? "The owner paused Auto Copy. Ask them to resume it." : currentStatus.clickThrough ? "Click-through is on" : "Live connection status";
  document.getElementById("strip-opacity").textContent = `${percent}%`;
  document.getElementById("strip-opacity").title = `Background ${percent}% · Controls to adjust`;
  document.getElementById("copy-answer").disabled = !currentStatus.hasAnswer;
  document.getElementById("clear-view").disabled = !currentStatus.hasAnswer;
  document.getElementById("theme-toggle").disabled = currentStatus.interactivePage !== false;
  const appIconCheckbox = document.getElementById("show-app-icon");
  appIconCheckbox.checked = currentStatus.interactivePage !== false || !currentStatus.hideAppIcon;
  appIconCheckbox.disabled = currentStatus.interactivePage !== false;
  appIconCheckbox.setAttribute("aria-label", `Show app icon in ${currentStatus.iconLabel || "Taskbar"}`);
  document.getElementById("app-icon-label").textContent = currentStatus.iconLabel || "Taskbar";
  if (currentStatus.toolbarHidden && !wasCollapsed && focusInPanel) showControlsButton.focus();
  if (!currentStatus.toolbarHidden && wasCollapsed && !currentStatus.interactivePage && document.activeElement === showControlsButton) hideControlsButton.focus();

  statusMessage.classList.remove("error-message");
  statusMessage.textContent = !currentStatus.shortcut
    ? "Show/hide shortcut unavailable. Use Controls or launch this app again to return."
    : currentStatus.message || "Connecting to your workspace…";
  statusMessage.title = [statusMessage.textContent, currentStatus.message].filter(Boolean).join(" ");
}

async function runOpen(action) {
  if (opening) return;
  opening = true;
  retryButton.disabled = reloadButton.disabled = true;
  errorMessage.hidden = true;
  errorPanel.hidden = true;
  errorDetails = null;
  statusMessage.classList.remove("error-message");
  statusMessage.textContent = "Opening your viewer…";
  try {
    const result = await action();
    if (!result || !result.ok) {
      showError(result && result.error, result?.diagnostics);
    } else {
      applyStatus(await api.status());
    }
  } catch (error) {
    const code = String(error?.message || "").includes("APP_TOOLBAR") ? "APP_TOOLBAR" : "APP_IPC";
    showError(`The app could not start its page controls. Close it completely and reopen the latest app. If it repeats, choose Copy error details. [${code}]`,
      { app: "Live Workspace Viewer", version: currentStatus?.version || "unknown", error: { code, stage: "toolbar" } });
  } finally {
    opening = false;
    retryButton.disabled = reloadButton.disabled = false;
  }
}
retryButton.addEventListener("click", () => { void runOpen(() => api.reload()); });
document.getElementById("copy-error").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Checking connection…";
  try {
    if (errorDetails?.error?.stage === "toolbar") await navigator.clipboard.writeText(JSON.stringify(errorDetails, null, 2));
    else await api.copyDiagnostics();
    button.textContent = "Copied — send these details to the owner";
  } catch { button.textContent = "Copy failed — send the error code above"; }
  finally { button.disabled = false; }
});
hideControlsButton.addEventListener("click", async () => {
  try {
    const status = await api.setToolbarVisible(false);
    if (status) applyStatus(status);
  } catch {
    showError("The controls could not be hidden. Try Ctrl+Alt+B.");
  }
});
showControlsButton.addEventListener("click", async () => {
  try {
    const status = await api.setToolbarVisible(true);
    if (status) applyStatus(status);
    hideControlsButton.focus();
  } catch {
    showError("The controls could not be opened. Try Ctrl+Alt+B.");
  }
});
stripCloseButton.addEventListener("click", () => api.quit());
document.getElementById("copy-answer").addEventListener("click", async event => {
  const button = event.currentTarget;
  const result = await api.copyAnswer().catch(() => null);
  button.textContent = result?.ok ? "Copied" : "Retry";
  setTimeout(() => { button.textContent = "Copy"; }, 1500);
});
document.getElementById("clear-view").addEventListener("click", () => api.clearView().catch(() => {}));
document.getElementById("theme-toggle").addEventListener("click", () => api.toggleTheme().catch(() => {}));
document.getElementById("show-app-icon").addEventListener("change", async event => {
  try {
    const status = await api.setIconVisible(event.currentTarget.checked);
    if (status) applyStatus(status);
  } catch { showError("Could not change the app icon setting."); }
});

document.getElementById("reload").addEventListener("click", () => { void runOpen(() => api.reload()); });
hideButton.addEventListener("click", () => {
  if (!hideButton.disabled) api.hide();
});
document.getElementById("close").addEventListener("click", () => api.quit());
pinCheckbox.addEventListener("change", async () => {
  try {
    const status = await api.setPinned(pinCheckbox.checked);
    if (status) applyStatus(status);
  } catch {
    pinCheckbox.checked = Boolean(currentStatus && currentStatus.pinned);
    showError("The window position setting could not be changed.");
  }
});
clickThroughCheckbox.addEventListener("change", async () => {
  try {
    const status = await api.setClickThrough(clickThroughCheckbox.checked);
    if (status) applyStatus(status);
  } catch {
    clickThroughCheckbox.checked = Boolean(currentStatus && currentStatus.clickThrough);
    showError("Click-through could not be changed.");
  }
});

async function changeOpacity(delta) {
  try {
    const status = await api.adjustOpacity(delta);
    if (status) applyStatus(status);
  } catch {
    showError("Opacity could not be changed.");
  }
}
opacityUp.addEventListener("click", () => changeOpacity(0.05));
opacityDown.addEventListener("click", () => changeOpacity(-0.05));

function syncPointer(clientY) {
  if (!api) return;
  const over = clientY < headerLimit();
  if (over === lastPointerOverToolbar) return;
  lastPointerOverToolbar = over;
  api.setPointerOverToolbar(over).catch(() => {});
}
document.addEventListener("mousemove", (event) => syncPointer(event.clientY));
document.addEventListener("mouseleave", () => {
  lastPointerOverToolbar = false;
  if (api) api.setPointerOverToolbar(false).catch(() => {});
});

if (api) {
  const unsubscribe = api.onStatus(applyStatus);
  window.addEventListener("unload", () => {
    if (typeof unsubscribe === "function") unsubscribe();
  }, { once: true });
  Promise.resolve(api.status()).then(applyStatus).catch(() => {
    applyStatus({});
    showError("Could not check window protection. Close and reopen this app.");
  });
} else {
  applyStatus({});
  retryButton.disabled = true;
  pinCheckbox.disabled = true;
  clickThroughCheckbox.disabled = true;
  opacityUp.disabled = true;
  opacityDown.disabled = true;
  document.getElementById("reload").disabled = true;
  document.getElementById("close").disabled = true;
  showControlsButton.disabled = true;
  stripCloseButton.disabled = true;
  showError("Open the desktop app to use this viewer.");
}
