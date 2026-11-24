"use strict";

const networkHelp = {
  ERR_FAILED: "The embedded page stopped loading without a specific network error. The app has retried automatically. Choose Retry connection, or Copy error details to check the server and proxy connection.",
  ERR_INTERNET_DISCONNECTED: "This app is offline. Reconnect this computer and choose Retry connection.",
  ERR_NAME_NOT_RESOLVED: "This app could not find the server. Check the server address and this computer's DNS/network settings.",
  ERR_CONNECTION_REFUSED: "The connection was refused. Check whether this network allows the desktop app to reach the server.",
  ERR_CONNECTION_RESET: "The connection was interrupted. Choose Retry connection; if Chrome works, check this app's network access with your network administrator.",
  ERR_CONNECTION_CLOSED: "The server connection closed. Choose Retry connection.",
  ERR_PROXY_CONNECTION_FAILED: "The app could not connect through this computer's proxy. Check its proxy settings with your network administrator.",
  ERR_TUNNEL_CONNECTION_FAILED: "The app's secure connection through the proxy failed. Check the proxy configuration with your network administrator.",
  ERR_TIMED_OUT: "The server took too long to respond. Wait briefly, then choose Retry connection.",
  ERR_CONNECTION_TIMED_OUT: "The server took too long to respond. Wait briefly, then choose Retry connection.",
  ERR_BLOCKED_BY_ADMINISTRATOR: "This computer's administrator blocked the app connection. Ask them to allow the workspace app.",
  ERR_BLOCKED_BY_CLIENT: "A local app or policy blocked the connection. Check the device's security policy with your administrator."
};

function describeOpenError(error, stage) {
  const code = String(error?.code || error?.message || "").match(/\bERR_[A-Z0-9_]+\b/)?.[0];
  const safeStage = ["prepare", "create-view", "configure-view", "attach-view", "load-page", "ready"].includes(stage) ? stage : "prepare";
  const fallback = `APP_${safeStage.replaceAll("-", "_").toUpperCase()}`;
  const errorCode = code || fallback;
  let help = networkHelp[code];
  if (code?.startsWith("ERR_CERT_") || code === "ERR_SSL_PROTOCOL_ERROR") {
    help = "The app could not verify the secure connection. Check the computer's date/time and ask your network administrator about its HTTPS certificates.";
  }
  if (!help) help = safeStage === "load-page"
    ? "The app could not load the access page. Choose Retry connection or Copy error details."
    : "The app could not start its embedded page. Close the app completely and reopen it. Copy these error details if it happens again.";
  return { code: errorCode, stage: safeStage, message: `${help} [${errorCode}]` };
}

module.exports = { describeOpenError };
