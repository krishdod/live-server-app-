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

const SELECTORS = {
  chatgpt: [
    '[data-message-author-role="assistant"] div.markdown',
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] .prose',
    '[data-message-author-role="assistant"] [class*="markdown"]',
    'article[data-turn="assistant"] div.markdown',
    'article[data-turn="assistant"] .markdown',
    'article[data-turn="assistant"]',
    '[data-testid="assistant-message"] .markdown',
    '[data-testid*="assistant-message"]',
    '[data-testid*="conversation-turn-"][data-testid*="assistant"]',
    'div[data-message-author-role="assistant"]',
    ".agent-turn .markdown",
    ".agent-turn",
    '[class*="agent-turn"] .markdown',
    '[class*="assistant-message"]'
  ]
};

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
    normalizeInlineText(p.innerText).replace(MARKER_PREFIX_RE, "")
  ).filter(Boolean);

  const text = parts.length
    ? parts.join(" ")
    : normalizeInlineText(li.innerText).replace(MARKER_PREFIX_RE, "");

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

function shouldMergeBlocks(prev, next) {
  if (!prev || !next) return false;
  if (prev.startsWith("```") || next.startsWith("```")) return false;
  if (/[.!?:]["')\]]*\s*$/.test(prev)) return false;
  if (/^[•\-*]/.test(next)) return false;
  return true;
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

    if (merged.length && shouldMergeBlocks(merged[merged.length - 1], text)) {
      merged[merged.length - 1] += text;
    } else {
      merged.push(text);
    }
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

function getAnswerContainer() {
  if (SITE === "perplexity") {
    return getPerplexityAnswerContainer();
  }

  const selectors = SELECTORS.chatgpt;
  let best = null;
  let bestLen = 0;

  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    if (!nodes.length) continue;

    // Prefer the last substantial assistant block (newest turn).
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      const len = (el.innerText || "").trim().length;
      if (len >= 8) {
        return el;
      }
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
  }

  return best;
}

function getLatestAnswer() {
  const container = getAnswerContainer();
  if (!container) return "";
  return extractFromContainer(container);
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

  if (typeof SERVER_URL === "string" && SERVER_URL) {
    fetch(`${SERVER_URL}/health`, { method: "GET", cache: "no-store" }).catch(() => {});
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

async function sendViaFetch(text) {
  if (typeof SERVER_URL !== "string" || !SERVER_URL) {
    return { sent: false, error: "SERVER_URL missing in config.js" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(`${SERVER_URL}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        key: typeof STREAM_KEY !== "undefined" ? STREAM_KEY || "" : ""
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    return { sent: response.ok, status: response.status };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
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
    if (!result.sent) {
      result = await sendViaFetch(text);
    }
  } finally {
    sendInFlight = false;
  }

  if (!result.sent) {
    lastSendFailed = true;
    console.error(
      "[Live Workspace] SEND FAILED",
      result.error || result.status || "unknown",
      "→",
      typeof SERVER_URL !== "undefined" ? SERVER_URL : "(no SERVER_URL)"
    );
  } else {
    console.log(
      "[Live Workspace] SEND OK",
      `${text.length} chars`,
      "→",
      typeof SERVER_URL !== "undefined" ? SERVER_URL : "(no SERVER_URL)"
    );
    if (lastSendFailed) {
      console.log("[Live Workspace] SEND recovered after earlier failure");
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

  if (previousAnswer && answer.length < previousAnswer.length * 0.3) {
    sendAnswer("");
  }

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

console.log(`[Live Workspace] Watching: ${SITE} (extractor v5.8 — upgrades)`);

ensureKeepAlive();
wakeServer(true);
setInterval(() => wakeServer(false), 45000);

try {
  chrome.runtime.sendMessage({ type: "ping" }, (res) => {
    if (chrome.runtime.lastError) {
      console.warn("[Live Workspace] Background unreachable — reload the extension");
      return;
    }
    console.log("[Live Workspace] Content SERVER_URL:", SERVER_URL);
    console.log("[Live Workspace] Background SERVER_URL:", res?.server || "(unknown)");
    if (res?.server && typeof SERVER_URL === "string" && res.server !== SERVER_URL) {
      console.warn(
        "[Live Workspace] SERVER MISMATCH — click Reload on the extension at chrome://extensions, then refresh this tab"
      );
    }
  });
} catch {
  // ignore
}

const initialAnswer = getLatestAnswer();
if (initialAnswer) {
  previousAnswer = initialAnswer;
  lastExtractedLen = initialAnswer.length;
  sendAnswer(initialAnswer);
  console.log(`[Live Workspace] Found existing answer (${initialAnswer.length} chars)`);
} else {
  console.log("[Live Workspace] Waiting for answer — ask a question, then watch for ANSWER CHANGED logs");
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
