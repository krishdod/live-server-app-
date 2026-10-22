"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const destination = path.join(__dirname, "source");
const files = [
  "VIEWER-ACCESS.md",
  "render.yaml",
  "server/server.js",
  "server/approval.js",
  "server/viewer.html",
  "server/access.html",
  "server/access.js",
  "server/access.css",
  "server/access-admin.html",
  "server/access-admin.js",
  "server/markdown.js",
  "server/package.json",
  "server/package-lock.json",
  "server/vendor/README.md",
  "server/vendor/marked.umd.js",
  "server/vendor/purify.min.js",
  "server/vendor/marked-LICENSE",
  "server/vendor/dompurify-LICENSE",
  "server/test/approval.test.js",
  "server/test/relay.test.js",
  "server/test/viewer.test.js",
  "server/test/access-ui.test.js",
  "server/test/ui-harness.js",
  "server/test/formatting.test.js",
  "desktop-viewer/main.js",
  "desktop-viewer/policy.js",
  "desktop-viewer/preload.js",
  "desktop-viewer/home.html",
  "desktop-viewer/home.js",
  "desktop-viewer/home.css",
  "desktop-viewer/package.json",
  "desktop-viewer/package-lock.json",
  "desktop-viewer/README.md",
  "desktop-viewer/test/viewer.test.js",
  "desktop-viewer/smoke-test.js",
  "desktop-viewer/approval-smoke-test.js",
  "README.md",
  ".gitignore"
];
const manifest = [];
for (const relative of files) {
  const source = relative === "README.md" ? path.join(__dirname,"README.md")
    : relative === ".gitignore" ? path.join(__dirname,"gitignore.txt") : path.join(root,relative);
  const target = path.join(destination,relative);
  if (!target.startsWith(destination + path.sep)) throw new Error("Outside source package");
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const content=fs.readFileSync(source);
  fs.writeFileSync(target,content);
  manifest.push({path:relative,sha256:crypto.createHash("sha256").update(content).digest("hex")});
}
fs.writeFileSync(path.join(__dirname,"manifest.json"),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({files:manifest.length,source:destination}));

