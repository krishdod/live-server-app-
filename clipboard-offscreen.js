"use strict";
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "lw-clipboard-offscreen" || message.type !== "copy-text" || sender.id !== chrome.runtime.id || sender.tab) return;
  const input = document.getElementById("clipboardText");
  try {
    if (typeof message.text !== "string" || message.text.length > 500000) throw new Error("Invalid caption text");
    input.value = message.text;
    input.select();
    // Offscreen documents cannot be focused. Chrome's supported fallback for
    // clipboard writes before worker Clipboard API support is execCommand.
    if (!document.execCommand("copy")) throw new Error("Clipboard denied");
    sendResponse({ok:true});
  } catch { sendResponse({ok:false}); }
  finally { input.value = ""; }
});
