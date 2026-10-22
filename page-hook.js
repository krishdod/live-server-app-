/* Runs in the page MAIN world so we can see ChatGPT's own fetch/SSE. */
(function () {
  if (window.__liveWorkspaceHooked) return;
  window.__liveWorkspaceHooked = true;

  const CHANNEL = "__LIVE_WORKSPACE_STREAM__";
  const origFetch = window.fetch.bind(window);
  let nextRequestId = 0;
  let activeRequestId = 0;
  let streamingRequestId = 0;
  let lastAnswerEvent = null;
  let lastLifecycleEvent = null;

  function post(type, requestId, extra = {}) {
    const event = { source: CHANNEL, type, requestId, ...extra };
    if (type === "answer") lastAnswerEvent = event;
    if (type === "stream-start" || type === "stream-end") lastLifecycleEvent = event;
    window.postMessage(event, "*");
  }

  function emit(text, requestId, via) {
    if (requestId !== activeRequestId || typeof text !== "string") return;
    const cleaned = text.replace(/\u0000/g, "").trimEnd();
    if (cleaned) post("answer", requestId, { text: cleaned, meta: { via } });
  }

  function isVisibleAssistant(message) {
    return message?.author?.role === "assistant"
      && (!message.channel || message.channel === "final")
      && (!message.recipient || message.recipient === "all")
      && !message.metadata?.is_visually_hidden_from_conversation;
  }

  function textFromMessage(message) {
    if (!isVisibleAssistant(message) || !message.content) return "";
    const content = message.content;
    if (Array.isArray(content.parts)) {
      return content.parts.map((part) => {
        if (typeof part === "string") return part;
        return typeof part?.text === "string" ? part.text : "";
      }).join("");
    }
    return typeof content.text === "string" ? content.text : "";
  }

  function extractFromConversation(data) {
    if (!data || typeof data !== "object") return "";
    if (data.message) return textFromMessage(data.message);
    if (!data.mapping || typeof data.mapping !== "object") return "";

    // Follow the selected branch, never the longest answer in another branch.
    if (data.current_node && data.mapping[data.current_node]) {
      let id = data.current_node;
      const seen = new Set();
      while (id && data.mapping[id] && !seen.has(id)) {
        seen.add(id);
        const node = data.mapping[id];
        const text = textFromMessage(node.message);
        if (text) return text;
        id = node.parent;
      }
      return "";
    }

    let best = "";
    let bestTime = -Infinity;
    for (const node of Object.values(data.mapping)) {
      const text = textFromMessage(node?.message);
      if (!text) continue;
      const time = Number(node.message.create_time) || 0;
      if (time >= bestTime) {
        bestTime = time;
        best = text;
      }
    }
    return best;
  }

  function applyPatch(state, operation, path, value) {
    if (operation === "patch" && Array.isArray(value)) {
      for (const patch of value) {
        if (!patch || typeof patch !== "object") continue;
        applyPatch(state, patch.o || patch.op || "append",
          path + (patch.p || patch.path || ""), patch.v ?? patch.value);
      }
      return;
    }
    if (!["add", "replace", "append", "remove"].includes(operation)) return;
    if (!path) {
      if (operation === "add" || operation === "replace") state.payload = value;
      return;
    }
    const keys = path.split("/").slice(1).map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!keys.length || keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) return;
    if (!state.payload || typeof state.payload !== "object") state.payload = {};
    let target = state.payload;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      }
      target = target[key];
    }
    const key = keys[keys.length - 1];
    if (operation === "remove") {
      if (Array.isArray(target)) target.splice(Number(key), 1);
      else delete target[key];
    } else if (operation === "append") {
      if (typeof value === "string") target[key] = (typeof target[key] === "string" ? target[key] : "") + value;
      else if (Array.isArray(value)) target[key] = [...(Array.isArray(target[key]) ? target[key] : []), ...value];
    } else if (Array.isArray(target) && key === "-") {
      target.push(value);
    } else {
      target[key] = value;
    }
  }

  function ingestParsed(parsed, state) {
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.message || parsed.mapping) {
      state.payload = parsed;
      state.text = extractFromConversation(parsed);
      return;
    }
    if (typeof parsed.delta === "string") {
      if (!state.payload?.message || isVisibleAssistant(state.payload.message)) state.text += parsed.delta;
      return;
    }
    if (Object.hasOwn(parsed, "v")) {
      // Compact frames omit the operation/path when unchanged.
      const operation = parsed.o || state.operation || "add";
      const path = typeof parsed.p === "string" ? parsed.p : state.path || "";
      applyPatch(state, operation, path, parsed.v);
      state.operation = operation;
      state.path = path;
      state.text = extractFromConversation(state.payload);
    }
  }

  async function parseSSE(stream, requestId) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const state = { text: "", payload: null, operation: "", path: "" };
    let buffer = "";
    let dataLines = [];
    let lastEmitAt = 0;
    let lastEmitted = "";

    const maybeEmit = (force) => {
      if (!state.text || state.text === lastEmitted) return;
      const now = Date.now();
      if (!force && now - lastEmitAt < 90) return;
      lastEmitAt = now;
      lastEmitted = state.text;
      emit(state.text, requestId, "sse");
    };
    const flushEvent = () => {
      const data = dataLines.join("\n");
      dataLines = [];
      if (!data) return;
      if (data.trim() === "[DONE]") { maybeEmit(true); return; }
      try {
        ingestParsed(JSON.parse(data), state);
        maybeEmit(false);
      } catch {
        // Metadata and non-JSON events are not answer text.
      }
    };
    const line = (value) => {
      if (!value) flushEvent();
      else if (value.startsWith("data:")) dataLines.push(value.slice(5).replace(/^ /, ""));
    };
    const consume = (final) => {
      let end;
      while ((end = buffer.search(/[\r\n]/)) !== -1) {
        if (!final && buffer[end] === "\r" && end === buffer.length - 1) break;
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + width);
      }
      if (final) {
        if (buffer) line(buffer);
        flushEvent();
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        consume(false);
      }
      buffer += decoder.decode();
      consume(true);
    } finally {
      maybeEmit(true);
      reader.releaseLock();
    }
  }

  function conversationRequest(input) {
    try {
      const value = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return null;
      return /^\/backend-api\/(?:f\/)?conversation(?:\/[^/]+)?$/.test(url.pathname) ? url : null;
    } catch {
      return null;
    }
  }

  window.fetch = async function patchedFetch(input, init) {
    const url = conversationRequest(input);
    if (!url) return origFetch(input, init);
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const isGeneration = method === "POST" && /\/conversation$/.test(url.pathname);
    const requestId = ++nextRequestId;
    if (isGeneration) {
      activeRequestId = requestId;
      streamingRequestId = requestId;
      lastAnswerEvent = null;
      post("stream-start", requestId);
    }
    const finish = () => {
      if (streamingRequestId === requestId) streamingRequestId = 0;
      if (requestId === activeRequestId) post("stream-end", requestId);
    };
    let response;
    try {
      response = await origFetch(input, init);
    } catch (error) {
      if (isGeneration) finish();
      throw error;
    }
    try {
      if (!response?.ok) {
        if (isGeneration) finish();
        return response;
      }
      const contentType = response.headers?.get("content-type") || "";
      if (isGeneration && !/json/i.test(contentType)) {
        parseSSE(response.clone().body, requestId).catch(() => {}).finally(finish);
      } else if (/json/i.test(contentType)) {
        response.clone().json().then((data) => {
          // Ignore history prefetches for conversations not on screen.
          const conversationId = data.conversation_id || (/\/conversation\/(.+)$/.exec(url.pathname) || [])[1];
          if (conversationId && !location.pathname.endsWith("/c/" + conversationId)) return;
          if (!isGeneration && streamingRequestId) return;
          if (requestId < activeRequestId) return;
          const text = extractFromConversation(data);
          if (!text) return;
          activeRequestId = requestId;
          emit(text, requestId, "json");
          if (!isGeneration) post("stream-end", requestId);
        }).catch(() => {}).finally(() => { if (isGeneration) finish(); });
      } else if (isGeneration) finish();
    } catch {
      if (isGeneration) finish();
      // Observing a response must never interrupt ChatGPT's own request.
    }
    return response;
  };

  // The hook starts before the content script; replay anything it missed loading.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== CHANNEL || event.data.type !== "request-state") return;
    if (lastLifecycleEvent?.type === "stream-start") window.postMessage(lastLifecycleEvent, "*");
    if (lastAnswerEvent) window.postMessage(lastAnswerEvent, "*");
    if (lastLifecycleEvent?.type === "stream-end") window.postMessage(lastLifecycleEvent, "*");
  });
  post("hook-ready", 0);
})();
