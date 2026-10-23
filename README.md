# Live Workspace

Stream formatted answers from ChatGPT or Perplexity into an owner-approved desktop reading window.

**[Start here](START-HERE.md)** for installation, connection settings and the first successful answer.

## Current release

- Windows viewer 1.5.1: compact controls, translucent reading surface, opaque text, connection status, Copy, local Clear, themes, explicit hide/show and an optional taskbar icon. The approved viewer hides its icon by default while the window stays visible.
- Browser extension 5.4: live capture, newest-answer delivery queue, persistent connection settings and a delivery test that does not change the shared answer.
- Node relay: formatted live updates, owner approval, revocation and recovery from stalled connections.

Local packages are generated in `releases/`. The Windows executable and extension ZIP are ready to use after configuration. The Mac ZIP contains source and a launcher; it is not a signed Mac installer.

## Connect the browser extension

1. Open `chrome://extensions`, enable Developer mode and load this folder (or the extracted extension ZIP). Reload an existing installation.
2. Refresh the ChatGPT tab.
3. Open the extension popup → Connection settings.
4. Set `https://live-server-app.onrender.com` and your Render service’s `STREAM_KEY`.
5. Save connection → Test delivery. Continue when it says Key accepted.
6. Open the desktop viewer, request access and have the owner approve the matching code. Ask a new question to test the complete path.

Saved popup settings take precedence over optional `config.js`. Server addresses must have no page path; the app’s viewer link ends in `/access`. Publishing and owner keys have different roles. Keys are never included in generated packages.

## Server deployment

Use the repository’s `server/` directory on Render. Build: `npm ci`. Start: `npm start`.

Set a private `EDIT_KEY`, a separate `STREAM_KEY`, `VIEWER_APPROVAL_REQUIRED=true`, and `APP_ORIGIN=https://live-server-app.onrender.com`. Retain your existing optional app password and SMTP settings. Run one instance: approvals and the latest answer are currently held in memory and reset when the server restarts.

[Viewer access and owner setup](VIEWER-ACCESS.md) explains approval, expiry, revocation and password behavior. Local website changes require a deployment before they appear on Render.

For local development, set unique test keys and run `npm start` in `server/`. The default local port is 8765.

## Project layout

- `background.js`, `content.js`, `page-hook.js`, `popup.*`, `manifest.json`: browser extension.
- `server/`: relay, website, approval flow and formatting.
- `desktop-viewer/`: Electron viewer and its native integration checks.
- `caption-copier-fix/`: the separate caption-to-ChatGPT app, preserved with its source.
- `scripts/package-releases.py`: builds extension and Mac-source ZIPs from current source only.
- `tests/`: capture, transport and popup regressions.
- `artifacts/`: ignored current test evidence; historical delivery copies have been removed.

Old versioned viewer builds, duplicate Mac launchers and historical delivery bundles are removed. Their committed source is recoverable from Git history.

## Checks and packages

Install dependencies with `npm ci` in the project root, `server/` and `desktop-viewer/`. Then run:

```powershell
npm.cmd test
npm.cmd test --prefix desktop-viewer
npm.cmd run test:approval-smoke --prefix desktop-viewer
npm.cmd run test:transparency --prefix desktop-viewer
python caption-copier-fix/test_web_send.py
python scripts/package-releases.py
```

The native integration checks run local fixtures with fake credentials. They do not send content to the hosted workspace.

## Privacy and protection

Owner approval controls access to the shared answer. Desktop capture exclusion depends on the operating system and capture method; test it with the person receiving your screen share. The process stays visible in Task Manager or Activity Monitor. See the [desktop notes](desktop-viewer/README.md) for the controls and platform limits.
