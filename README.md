# Live Workspace

Stream formatted answers from ChatGPT or Perplexity into an owner-approved desktop reading window.

**[Start here](START-HERE.md)** for installation, connection settings and the first successful answer.

**Meeting captions (preview):** a local English caption sender can relay text and
estimated speaker labels to the helper through a separate channel. See
[setup and limitations](meeting-captions/START-HERE.md). Deploy the new server
routes before using this feature; it is separate from the existing answer viewer.

## Current release

- Viewer 1.6.0: bundled server address, automatic connection, bounded retries, clearer connection diagnostics, patched Electron runtime, and Windows setup/portable packages. Compact controls, translucent backgrounds and opaque text remain available after approval.
- Browser extension 5.4.2: live capture and automatic copying of finished meeting captions while you use ChatGPT. Adds clipboard-writing permission and a background helper; it never reads the clipboard. Existing capture protections, connection settings and answer delivery remain available.
- Node relay: formatted live updates, owner approval, revocation and recovery from stalled connections.

Local packages are generated in `releases/`. Recipients use the Windows setup EXE or the universal Mac DMG built by GitHub Actions. The app includes its runtime and needs no URL entry. Mac test packages are ad-hoc signed; Developer ID signing and notarization are a separate distribution requirement. Old Mac source ZIPs are not recipient installers.

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
- `scripts/package-releases.py`: builds extension/share ZIPs, recipient notes and release checksums, without credentials.
- `.github/workflows/build-viewer.yml`: builds Windows packages and universal Mac DMG/ZIP artifacts on their native operating systems.
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
