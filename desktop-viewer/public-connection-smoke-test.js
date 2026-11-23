"use strict";
// Read only the public access form. Never submit a request or use owner/publishing keys.
const electron = require("electron");
const { app } = electron;
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createViewer } = require(path.join(process.env.LW_SMOKE_APP_ROOT || __dirname, "main.js"));
const output = path.join(__dirname, "../artifacts/portable-checks");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "lw-public-check-")));
let viewer, finished = false;
const timer = setTimeout(() => finish(false), 105000);
function finish(passed) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const result = { passed, version: viewer?.diagnosticDetails().version,
    automaticStartup: passed, publicAccessPage: passed, accessRequestSubmitted: false,
    ...(passed ? {} : { diagnostics: viewer?.diagnosticDetails() }) };
  fs.writeFileSync(path.join(output, "public-connection.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  viewer?.window.close();
  app.exit(passed ? 0 : 1);
}
app.whenReady().then(async () => {
  viewer = createViewer(electron, { showWindow: false, registerShortcut: false });
  for (let attempt = 0; attempt < 1000 && !finished; attempt++) {
    const contents = viewer.getView()?.webContents;
    if (contents && !contents.isDestroyed() && !viewer.snapshot().opening) {
      const ready = await contents.executeJavaScript("Boolean(document.querySelector('#requestForm'))").catch(() => false);
      if (ready) { finish(true); return; }
    }
    if (!viewer.snapshot().opening && viewer.snapshot().failure) { finish(false); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}).catch(() => finish(false));
