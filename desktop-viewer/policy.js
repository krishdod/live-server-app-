"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

function isToolbarFile(candidate, expectedPath) {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "file:" || url.search || url.hash) return false;
    const candidatePath = fileURLToPath(url);
    const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (normalize(candidatePath) === normalize(expectedPath)) return true;
    // Windows can load a long path while the portable launcher uses its 8.3
    // alias. Resolve both without granting another file or another renderer.
    return normalize(fs.realpathSync(candidatePath)) === normalize(fs.realpathSync(expectedPath));
  } catch { return false; }
}

function trustedToolbar(event, contents, homePath) {
  try {
    if (event.sender !== contents) return false;
    const frame = event.senderFrame;
    const main = contents.mainFrame;
    const sameFrame = frame === main || (Number.isInteger(frame?.processId) && Number.isInteger(frame?.routingId) &&
      frame.processId === main.processId && frame.routingId === main.routingId);
    return sameFrame && isToolbarFile(frame.url, homePath);
  } catch { return false; }
}

function normalizeViewerUrl(value) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Paste a valid viewer link.");
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Paste the full viewer link, starting with https://."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use HTTPS, or HTTP on localhost for a local server.");
  }
  if (url.username || url.password) throw new Error("Use the viewer's login page, not a password in the address.");
  if (["github.com", "www.github.com", "raw.githubusercontent.com"].includes(url.hostname)) {
    throw new Error("Paste the live viewer link, not the GitHub repository address.");
  }
  return url.href;
}

function allowedNavigation(candidate, viewerUrl) {
  try { return new URL(normalizeViewerUrl(candidate)).origin === new URL(viewerUrl).origin; }
  catch { return false; }
}

// This is only a window interaction hint. The server still authorizes every
// viewer connection. Login, approval, error and admin pages stay interactive.
function isReadyViewer(candidate, originUrl, title) {
  if (title !== "Live Workspace — Ready" || !allowedNavigation(candidate, originUrl)) return false;
  const url = new URL(candidate);
  return url.pathname === "/" && url.searchParams.get("role") === "view";
}

function supportsCaptureExclusion(platform, release) {
  // Electron setContentProtection is supported on Windows and macOS.
  if (platform === "darwin") return true;
  const [major, , build] = String(release).split(".").map(Number);
  return platform === "win32" && (major > 10 || (major === 10 && build >= 19041));
}

module.exports = { normalizeViewerUrl, allowedNavigation, isReadyViewer, supportsCaptureExclusion, isToolbarFile, trustedToolbar };
