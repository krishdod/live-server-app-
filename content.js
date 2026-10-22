console.log("[Live Workspace] Extension loaded on:", location.href);

const SITE = location.hostname.includes("chatgpt") || location.hostname.includes("openai")
  ? "chatgpt"
  : "perplexity";

const PERPLEXITY_CONTAINER_SELECTORS = [
  'div[id^="markdown-content-"]',
  '[data-testid="answer-content"]',
  '[data-testid="search-result"]'
];

const PERPLEXITY_PROSE_SELECTORS = [
  'div.prose[data-renderer="lm"]',
  'div.prose[data-renderer]',
  "div.prose"
];

const CHATGPT_ASSISTANT_SELECTOR = [
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]',
  '[data-message-author="assistant"]',
  'article[data-turn="assistant"]',
  '[data-turn="assistant"]',
  '[data-testid="assistant-message"]',
  '[data-testid="assistant-turn"]',
  '.agent-turn'
].join(", ");

const MARKER_RE = /^[•*·∙●◦.\-]+$/u;
const MARKER_PREFIX_RE = /^[•*·∙●◦.\-]\s*/u;
const BLOCK_TAGS = new Set(["p", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);

const LIVE_PUBLISH_MS = 100;
const POLL_MS = 200;
const STABLE_TICKS_FOR_FINAL = 5;
const SCROLL_PAUSE_MS = 4000;

let previousAnswer = "";
let lastExtractedLen = 0;
let stableTicks = 0;
let liveTimer = null;
let lastPublishAt = 0;
let lastUrl = location.href;
let lastPathname = location.pathname;
let userReadingHistory = false;
let readingUntil = 0;
let pendingDomChange = false;
let keepAlivePort = null;
let lastSendFailed = false;
let lastRetryAt = 0;
let sendInFlight = false;
let queuedSendText = null;
let networkAnswer = "";
let networkStreaming = false;
let networkRequestId = 0;
let networkDomContainer = null;
let networkDomText = "";
const STREAM_CHANNEL = "__LIVE_WORKSPACE_STREAM__";

function isMarkerOnly(text) {
  return MARKER_RE.test(text.trim());
}

function normalizeInlineText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeCodeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n$/, "");
}

function detectCodeLanguage(el) {
  const className = `${el.className || ""} ${el.getAttribute?.("data-language") || ""}`;
  const fromClass = className.match(/language-([\w+-]+)/i);
  if (fromClass) return fromClass[1].toLowerCase();

  const dataLang = el.getAttribute?.("data-lang") || el.getAttribute?.("data-language");
  if (dataLang) return String(dataLang).toLowerCase();

  return "";
}

function extractCodeBlock(preEl) {
  const codeEl = preEl.querySelector("code") || preEl;
  let lang = detectCodeLanguage(codeEl) || detectCodeLanguage(preEl);

  if (!lang) {
    const header = preEl.previousElementSibling
      || preEl.parentElement?.querySelector?.(":scope > :first-child");
    const labelText = normalizeInlineText(header?.innerText || "").split(/\s+/)[0] || "";
    const known = /^(sql|python|javascript|typescript|java|json|html|css|bash|shell|c|cpp|csharp|go|rust|php|ruby|kotlin|swift|yaml|xml|r|plaintext|text)$/i;
    if (known.test(labelText)) {
      lang = labelText.toLowerCase();
    }
  }

  return {
    type: "code",
    lang,
    text: normalizeCodeText(codeEl.textContent)
  };
}

function formatCodeBlock(block) {
  const fence = "```";
  const lang = block.lang || "";
  return `${fence}${lang}\n${block.text}\n${fence}`;
}

function isCodeBlock(block) {
  return Boolean(block && typeof block === "object" && block.type === "code");
}

function flattenListItem(li) {
  const parts = [...li.querySelectorAll("p")].map((p) =>
    normalizeInlineText(p.innerText || p.textContent || "").replace(MARKER_PREFIX_RE, "")
  ).filter(Boolean);

  const text = parts.length
    ? parts.join(" ")
    : normalizeInlineText(li.innerText || li.textContent || "").replace(MARKER_PREFIX_RE, "");

  return text ? `• ${text}` : "";
}

function mergeOrphanBullets(text) {
  const lines = text.split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (isMarkerOnly(trimmed)) {
      while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
      if (i + 1 < lines.length) {
        const next = lines[++i].trim();
        if (next) out.push(`• ${next.replace(MARKER_PREFIX_RE, "")}`);
      }
      continue;
    }

    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }

    const line = trimmed.replace(MARKER_PREFIX_RE, "• ");
    out.push(line);
  }

  return out
    .join("\n")
    .replace(/^•\s*\n+([^\n])/gm, "• $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinBlocks(blocks) {
  const merged = [];

  for (const block of blocks) {
    if (isCodeBlock(block)) {
      if (!block.text.trim()) continue;
      merged.push(formatCodeBlock(block));
      continue;
    }

    const text = mergeOrphanBullets(typeof block === "string" ? block : block.text || "");
    if (!text) continue;

    merged.push(text);
  }

  return merged.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripAnswerChrome(root) {
  root.querySelectorAll(
    "button, form, nav, aside, svg, [class*='citation'], [class*='Citation'], [class*='source'], [class*='follow-up'], [class*='FollowUp'], [class*='related']"
  ).forEach((node) => node.remove());
}

function extractRichText(el) {
  let out = "";

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent.replace(/\s+/g, " ");
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();

    if (tag === "code") {
      const value = node.textContent.replace(/\s+/g, " ").trim();
      if (value) out += `\`${value}\``;
      return;
    }

    if (tag === "br") {
      out += "\n";
      return;
    }

    for (const child of node.childNodes) walk(child);
  };

  walk(el);
  return out.replace(/[ \t]+\n/g, "\n").replace(/[ ]{2,}/g, " ").trim();
}

function extractStructuredBlocks(root) {
  const blocks = [];

  const walk = (node) => {
    for (const child of node.children) {
      const tag = child.tagName?.toLowerCase();

      if (tag === "ul" || tag === "ol") {
        const items = [];
        child.querySelectorAll(":scope > li").forEach((li) => {
          const line = flattenListItem(li);
          if (line) items.push(line);
        });
        if (items.length) blocks.push(items.join("\n"));
        continue;
      }

      if (tag === "li") continue;

      if (tag === "pre") {
        const codeBlock = extractCodeBlock(child);
        if (codeBlock.text.trim()) blocks.push(codeBlock);
        continue;
      }

      if (BLOCK_TAGS.has(tag)) {
        const text = extractRichText(child);
        if (text && !isMarkerOnly(text)) blocks.push(text);
        continue;
      }

      if (child.children.length) walk(child);
    }
  };

  walk(root);
  return blocks;
}

function extractFromContainer(container) {
  const clone = container.cloneNode(true);
  stripAnswerChrome(clone);

  if (typeof LiveMarkdown !== "undefined") return LiveMarkdown.fromElement(clone);

  const blocks = extractStructuredBlocks(clone);
  if (blocks.length) return joinBlocks(blocks);

  return mergeOrphanBullets(clone.innerText || clone.textContent || "");
}

function isSubstantialText(text) {
  return normalizeInlineText(text).length > 15;
}

function getPerplexityAnswerContainer() {
  for (const selector of PERPLEXITY_CONTAINER_SELECTORS) {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length) return nodes[nodes.length - 1];
  }

  const thread = document.querySelector(
    'div[class*="threadContentWidth"], div.max-w-threadContentWidth, main, [role="main"]'
  );
  const scope = thread || document.body;

  for (const selector of PERPLEXITY_PROSE_SELECTORS) {
    const proses = [...scope.querySelectorAll(selector)].filter((el) =>
      isSubstantialText(el.innerText)
    );
    if (proses.length) {
      const prose = proses[proses.length - 1];
      return prose.closest('div[id^="markdown-content-"]') || prose;
    }
  }

  return null;
}

function isLikelyUserPrompt(el) {
  if (!el || !el.closest) return false;
  return Boolean(
    el.closest('[data-message-author-role="user"]') ||
    el.closest('[data-role="user"]') ||
    el.closest('[data-message-author="user"]') ||
    el.closest('article[data-turn="user"]') ||
    el.closest('[data-turn="user"]') ||
    el.closest('[data-testid*="user-message"]') ||
    el.closest('.user-turn, [class*="user-turn"]')
  );
}

function isChromeUi(el) {
  if (!el || !el.closest) return true;
  return Boolean(
    el.closest(
      "nav, aside, header, footer, script, style, " +
      '[data-testid*="composer"], [class*="composer"], #prompt-textarea, ' +
      "textarea, [contenteditable='true']"
    )
  );
}

function queryAllDeep(selector, root = document) {
  const results = [];
  const seen = new Set();

  const visit = (node) => {
    if (!node) return;

    if (node.querySelectorAll) {
      try {
        node.querySelectorAll(selector).forEach((el) => {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        });
      } catch {
        // invalid selector in this root
      }
    }

    const all = node.querySelectorAll ? node.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };

  visit(root);
  return results;
}

function getAnswerContainer() {
  if (SITE === "perplexity") return getPerplexityAnswerContainer();

  // DOM order identifies the current reply. Length scoring picked older, longer
  // replies, while broad page fallbacks could accidentally publish the prompt.
  const candidates = queryAllDeep(CHATGPT_ASSISTANT_SELECTOR)
    .filter((el) => !isLikelyUserPrompt(el) && !isChromeUi(el));
  const latest = candidates[candidates.length - 1];
  if (!latest) return null;
  // Prefer its outer assistant wrapper so multiple Markdown sections survive.
  for (const candidate of candidates) {
    if (candidate !== latest && candidate.contains(latest)) return candidate;
  }
  return latest;
}

let lastMissLogAt = 0;
let lastHitLogAt = 0;
let didDomProbe = false;

function logDomProbe() {
  if (didDomProbe) return;
  didDomProbe = true;

  const probes = [
    "[data-message-author-role]",
    "[data-turn]",
    "[data-role]",
    "article",
    "main",
    "[class*=markdown]",
    "[class*=prose]",
    "[data-testid*=conversation]",
    "[data-testid*=assistant]"
  ];

  const summary = probes.map((sel) => {
    let count = 0;
    try {
      count = queryAllDeep(sel).length;
    } catch {
      count = -1;
    }
    return `${sel}=${count}`;
  });

  console.log(
    "[Live Workspace] DOM probe —",
    summary.join(", "),
    `| iframes=${document.querySelectorAll("iframe").length}`,
    `| frame=${window === window.top ? "top" : "child"}`
  );
}

function getLatestAnswer() {
  // The current stream is authoritative while tokens are arriving.
  if (SITE === "chatgpt" && networkStreaming && networkAnswer) return networkAnswer;

  // Child ads/widgets frames: stay quiet unless they actually host chat content.
  if (
    window !== window.top &&
    !document.querySelector(
      '[data-message-author-role], [data-turn], [data-testid*="conversation"], main article, [class*="markdown"]'
    )
  ) {
    return "";
  }

  const container = getAnswerContainer();
  if (!container) {
    if (networkAnswer) return networkAnswer;
    const now = Date.now();
    if (now - lastMissLogAt > 5000) {
      lastMissLogAt = now;
      logDomProbe();
      console.log(
        "[Live Workspace] No answer container yet — waiting for ChatGPT stream or DOM. " +
          "Ask a new question after reload if needed."
      );
    }
    return "";
  }

  const answer = extractFromContainer(container);
  // Keep a completed snapshot until the DOM catches up, but do not pin an old
  // network answer over subsequent replies that are only visible in the DOM.
  if (networkAnswer && container === networkDomContainer) {
    return networkAnswer;
  }
  const now = Date.now();
  if (answer && now - lastHitLogAt > 8000) {
    lastHitLogAt = now;
    console.log(
      `[Live Workspace] Extracted ${answer.length} chars from`,
      container.tagName,
      (typeof container.className === "string" && container.className) ||
        container.getAttribute("data-message-author-role") ||
        container.getAttribute("data-turn") ||
        ""
    );
  }
  return answer;
}

function getScrollRoot() {
  const candidates = [
    document.querySelector('[class*="react-scroll-to-bottom"] > div'),
    document.querySelector('div[class*="composer"]')?.parentElement?.querySelector(".overflow-y-auto"),
    ...document.querySelectorAll("main div.overflow-y-auto"),
    document.querySelector('[class*="overflow-y-auto"]')
  ].filter(Boolean);

  let best = null;
  let bestScore = 0;

  for (const el of candidates) {
    const score = el.scrollHeight - el.clientHeight;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function isNearBottom(el, threshold = 180) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function isPausedForScroll() {
  if (!userReadingHistory) return false;
  if (Date.now() > readingUntil) {
    userReadingHistory = false;
    return false;
  }
  const root = getScrollRoot();
  if (isNearBottom(root)) {
    userReadingHistory = false;
    return false;
  }
  return true;
}

function pauseForScrollUp() {
  const root = getScrollRoot();
  if (!root || isNearBottom(root)) return;
  userReadingHistory = true;
  readingUntil = Date.now() + SCROLL_PAUSE_MS;
}

function ensureKeepAlive() {
  try {
    if (keepAlivePort) return;
    keepAlivePort = chrome.runtime.connect({ name: "live-workspace" });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
    });
  } catch {
    keepAlivePort = null;
  }
}

function wakeServer(force = false) {
  try {
    chrome.runtime.sendMessage({ type: "wake", force }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // ignore
  }
}

async function sendViaBackground(text) {
  ensureKeepAlive();
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "answer", text }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ sent: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { sent: false });
      });
    } catch (err) {
      resolve({ sent: false, error: String(err) });
    }
  });
}

async function sendAnswer(text) {
  if (sendInFlight) {
    queuedSendText = text;
    return false;
  }

  sendInFlight = true;
  let result = { sent: false };

  try {
    result = await sendViaBackground(text);
  } finally {
    sendInFlight = false;
  }

  if (!result.sent) {
    // The worker marks authentication/configuration rejections as permanent.
    // Retrying the same answer cannot repair them and would flood the relay.
    lastSendFailed = result.retryable !== false;
    console.error("[Live Workspace] SEND FAILED", result.error || result.status || "unknown");
  } else {
    if (lastSendFailed) {
      console.log("[Live Workspace] SEND OK (recovered)");
    }
    lastSendFailed = false;
  }

  if (queuedSendText !== null && queuedSendText !== text) {
    const next = queuedSendText;
    queuedSendText = null;
    return sendAnswer(next);
  }
  queuedSendText = null;

  return Boolean(result.sent);
}

function queueLivePublish(source) {
  if (isPausedForScroll()) return;

  const answer = getLatestAnswer();
  if (!answer || answer === previousAnswer) return;

  const now = Date.now();
  const elapsed = now - lastPublishAt;

  clearTimeout(liveTimer);

  if (elapsed >= LIVE_PUBLISH_MS) {
    publishAnswer(source);
    lastPublishAt = Date.now();
    return;
  }

  liveTimer = setTimeout(() => {
    if (isPausedForScroll()) return;
    publishAnswer(source);
    lastPublishAt = Date.now();
  }, LIVE_PUBLISH_MS - elapsed);
}

function publishAnswer(source) {
  if (isPausedForScroll()) return;

  const answer = getLatestAnswer();
  if (!answer || answer === previousAnswer) return;

  previousAnswer = answer;
  lastExtractedLen = answer.length;
  console.log(`[Live Workspace] ANSWER CHANGED (${source}, ${answer.length} chars)`);
  sendAnswer(answer);
}

function conversationPath(href) {
  try {
    return new URL(href, location.origin).pathname;
  } catch {
    return href;
  }
}

function resetWatch(reason) {
  previousAnswer = "";
  lastExtractedLen = 0;
  stableTicks = 0;
  userReadingHistory = false;
  readingUntil = 0;
  pendingDomChange = true;
  lastSendFailed = false;
  queuedSendText = null;
  networkAnswer = "";
  networkStreaming = false;
  networkDomContainer = null;
  networkDomText = "";
  clearTimeout(liveTimer);
  console.log(`[Live Workspace] Reset — ${reason}`);
}

function maybeResetForNavigation() {
  const path = conversationPath(location.href);
  if (location.href === lastUrl) return;

  const pathChanged = path !== lastPathname;
  lastUrl = location.href;
  lastPathname = path;

  // ChatGPT often replaceState for minor UI state — only reset on real chat path changes.
  if (pathChanged) {
    resetWatch("navigation");
  }
}

function tick() {
  ensureKeepAlive();
  maybeResetForNavigation();

  if (userReadingHistory && Date.now() > readingUntil) {
    userReadingHistory = false;
  }
  if (userReadingHistory && isNearBottom(getScrollRoot())) {
    userReadingHistory = false;
  }

  if (isPausedForScroll()) {
    pendingDomChange = false;
    return;
  }

  if (pendingDomChange) {
    pendingDomChange = false;
    queueLivePublish("live");
  }

  if (lastSendFailed && previousAnswer && Date.now() - lastRetryAt > 2000) {
    lastRetryAt = Date.now();
    sendAnswer(previousAnswer);
  }

  const answer = getLatestAnswer();

  if (!answer) {
    stableTicks = 0;
    lastExtractedLen = 0;
    return;
  }

  if (answer.length === lastExtractedLen) {
    stableTicks++;
    if (stableTicks === STABLE_TICKS_FOR_FINAL && answer !== previousAnswer) {
      publishAnswer("final");
    }
  } else {
    stableTicks = 0;
    lastExtractedLen = answer.length;
    queueLivePublish("live");
  }
}

console.log(`[Live Workspace] Watching: ${SITE} (extractor v6.1 — network+dom)`);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== STREAM_CHANNEL) return;

  if (data.type === "hook-ready") {
    console.log("[Live Workspace] ChatGPT network hook ready");
    return;
  }

  if (typeof data.requestId === "number" && data.requestId < networkRequestId) return;
  if (typeof data.requestId === "number") networkRequestId = data.requestId;

  if (data.type === "stream-start") {
    networkAnswer = "";
    networkStreaming = true;
    pendingDomChange = true;
    return;
  }
  if (data.type === "stream-end") {
    networkStreaming = false;
    pendingDomChange = true;
    return;
  }

  if (data.type === "answer" && typeof data.text === "string" && data.text.trim()) {
    networkAnswer = data.text;
    networkDomContainer = getAnswerContainer();
    networkDomText = networkDomContainer ? extractFromContainer(networkDomContainer) : "";
    queueLivePublish("stream");
  }
});

window.postMessage({ source: STREAM_CHANNEL, type: "request-state" }, "*");

ensureKeepAlive();
wakeServer(true);
setInterval(() => wakeServer(false), 45000);

const initialAnswer = getLatestAnswer();
if (initialAnswer) {
  previousAnswer = initialAnswer;
  lastExtractedLen = initialAnswer.length;
  sendAnswer(initialAnswer);
  console.log(`[Live Workspace] Found existing answer (${initialAnswer.length} chars)`);
} else {
  console.log(
    "[Live Workspace] Waiting for answer — ask a NEW question so the network hook can capture the stream"
  );
}

const observer = new MutationObserver(() => {
  pendingDomChange = true;
});

function startObserver() {
  if (!document.body) return;
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

startObserver();

document.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) pauseForScrollUp();
}, { passive: true });

document.addEventListener("keydown", (event) => {
  if (event.key === "PageUp" || event.key === "Home" || (event.key === "ArrowUp" && !event.target?.closest?.("textarea, input, [contenteditable='true']"))) {
    pauseForScrollUp();
  }
});

window.addEventListener("popstate", () => {
  lastUrl = "";
  maybeResetForNavigation();
});
const _pushState = history.pushState;
history.pushState = function (...args) {
  const result = _pushState.apply(this, args);
  maybeResetForNavigation();
  return result;
};
const _replaceState = history.replaceState;
history.replaceState = function (...args) {
  const result = _replaceState.apply(this, args);
  maybeResetForNavigation();
  return result;
};

setInterval(tick, POLL_MS);
