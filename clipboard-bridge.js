(() => {
  "use strict";
  const channel = "lw-transcript-clipboard-v1";
  window.addEventListener("message", async event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || location.pathname !== "/transcripts" ||
        data?.channel !== channel || data.direction !== "request" || !Number.isSafeInteger(data.id) ||
        !["check","copy"].includes(data.operation)) return;
    let result;
    try {
      result = await chrome.runtime.sendMessage({type:"transcript-clipboard",operation:data.operation,text:data.text});
    } catch { result = {ok:false,error:"Reload the Live Workspace extension and refresh this page."}; }
    window.postMessage({channel,direction:"response",id:data.id,ok:result?.ok === true,
      error:result?.ok ? "" : (result?.error || "Clipboard extension is unavailable.")}, location.origin);
  });
})();
