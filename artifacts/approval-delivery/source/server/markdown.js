(function (root) {
  function fromElement(element) {
    const children = (node) => Array.from(node.childNodes || []).map(walk).join("");
    const inline = (node) => children(node).trim();
    function walk(node) {
      if (node.nodeType === 3) return node.textContent.replace(/[\\`*_[\]]/g, "\\$&");
      if (node.nodeType !== 1) return "";
      const tag = node.tagName.toLowerCase();
      if (["button", "script", "style", "svg", "nav", "aside", "form"].includes(tag)) return "";
      if (node.classList.contains("code-wrap")) return walk(node.querySelector("pre"));
      if (tag === "pre") {
        const code = node.querySelector("code") || node;
        const text = code.textContent.replace(/\r\n/g, "\n").replace(/\n$/, "");
        const lang = node.getAttribute("data-lang") || code.getAttribute("data-language")
          || (/language-([\w+-]+)/.exec(code.className || "") || [])[1] || "";
        const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
        return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
      }
      if (tag === "code") {
        const text = node.textContent;
        const fence = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
        return `${fence}${text}${fence}`;
      }
      if (tag === "br") return "\n";
      if (tag === "strong" || tag === "b") return `**${inline(node)}**`;
      if (tag === "em" || tag === "i") return `*${inline(node)}*`;
      if (tag === "del" || tag === "s") return `~~${inline(node)}~~`;
      if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${inline(node)}\n\n`;
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        return /^(https?:\/\/|mailto:)/i.test(href)
          ? `[${inline(node)}](<${href.replace(/[<>\s]/g, c => encodeURIComponent(c))}>)` : inline(node);
      }
      if (tag === "ul" || tag === "ol") {
        let index = Number(node.getAttribute("start")) || 1;
        const items = Array.from(node.children).filter(n => n.tagName === "LI").map(li => {
          const marker = tag === "ol" ? `${index++}. ` : "- ";
          return marker + children(li).trim().replace(/\n/g, "\n" + " ".repeat(marker.length));
        });
        return `\n\n${items.join("\n")}\n\n`;
      }
      if (tag === "table") {
        const rows = Array.from(node.querySelectorAll("tr")).map(tr =>
          Array.from(tr.children).filter(c => /^(TH|TD)$/.test(c.tagName))
            .map(c => inline(c).replace(/\|/g, "\\|").replace(/\n+/g, "<br>")));
        if (!rows.length) return "";
        const row = cells => `| ${cells.join(" | ")} |`;
        return `\n\n${[row(rows[0]), row(rows[0].map(() => "---")), ...rows.slice(1).map(row)].join("\n")}\n\n`;
      }
      if (tag === "blockquote") return `\n\n${inline(node).replace(/^/gm, "> ")}\n\n`;
      if (tag === "hr") return "\n\n---\n\n";
      const text = children(node);
      return ["p", "div", "section", "article"].includes(tag) ? `\n\n${text.trim()}\n\n` : text;
    }
    return walk(element).trim();
  }
  root.LiveMarkdown = { fromElement };
})(globalThis);
