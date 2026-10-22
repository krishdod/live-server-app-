# Live Workspace

## Viewer approval and desktop viewer v5

Viewers now request access at `/access`. The owner approves each request for
one hour or 24 hours at `/access-admin`, and can revoke access immediately.
Old viewer keys do not bypass approval. The existing owner login and extension
publishing flow are preserved. Approvals reset on server restart; no paid
service or database is required.

Read [Viewer access setup](VIEWER-ACCESS.md) before deploying. The updated
[desktop viewer](desktop-viewer/README.md) keeps approval screens clickable and
restores the usual window controls after approval. Deploy the server update
before distributing the new EXE. The older `desktop-overlay` instructions below
refer to the previous companion.


Stream live text from your browser to a teammate in real time — or open a **transparent desktop overlay** for mock-interview practice demos.

```
Your chat page
      ↓
content.js detects text changes
      ↓
background.js POSTs to relay server
      ↓
Teammate sees same text live
   (browser viewer  or  Electron overlay)
```

## Project structure

```
live-workspace/
├── manifest.json      # Chrome extension manifest
├── popup.html         # Extension popup (server status)
├── popup.js
├── content.js         # Watches the page for answer changes
├── background.js      # Sends text to the relay server (+ wake/queue)
├── config.js          # Server URL + STREAM_KEY (gitignored)
├── config.example.js  # Template for config.js
├── render.yaml        # Render deployment config
├── server/
│   ├── server.js      # HTTP + WebSocket relay server
│   ├── viewer.html    # Live viewer (+ ?overlay=1 practice mode)
│   └── package.json
└── desktop-overlay/   # Electron transparent always-on-top window
    ├── main.js
    ├── preload.js
    └── package.json
```

## Requirements

- Google Chrome
- Node.js 18+ (for local server, Render deploy, or overlay)

## Features

- Live streaming from ChatGPT / Perplexity
- Code blocks with highlighting + Copy
- Focus mode (full-width reading)
- Light / Dark theme
- Streaming / Paused badges
- Extension popup: server health, last sent, wake/test
- Offline queue if the server is briefly down
- **Practice Mode overlay** (Electron): always-on-top viewer for the other person, optional transparent mode
- Keyboard shortcuts (viewer):
  - `Alt+F` Focus
  - `Alt+L` Light/Dark
  - `Alt+C` Copy last code block
  - `Esc` Exit focus

## 1. Install the Chrome extension

1. Copy `config.example.js` to `config.js` and set your `SERVER_URL` / `STREAM_KEY`
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select this project folder
5. Click the extension icon to open the status popup

## 2. Run locally (same network)

### Start the server

```powershell
cd server
npm install
$env:EDIT_KEY="YOUR_UNIQUE_OWNER_KEY"
$env:STREAM_KEY="YOUR_UNIQUE_PUBLISHING_KEY"
npm start
```

The server runs at `http://localhost:8765` (`/health` for wake checks).

### Configure the extension

In `config.js`:

```js
var SERVER_URL = "http://localhost:8765";
var STREAM_KEY = "YOUR_UNIQUE_PUBLISHING_KEY";
```

Reload the extension at `chrome://extensions`.

### Share with a teammate on the same Wi‑Fi

1. Find your local IP:
   ```powershell
   ipconfig
   ```
2. Set `APP_ORIGIN=http://YOUR-IP:8765` on the local server and restart it.
3. Share `http://YOUR-IP:8765/access` and approve their request from your owner dashboard.

### Test

1. Open ChatGPT / Perplexity and ask a question
2. Open the viewer with **Auto Copy: ON**
3. Text should appear live; code stays formatted

## 3. Practice Mode overlay (portfolio / mock interview)

Use this when the **other person** needs a floating always-on-top answer panel (viewer-only). Solid by default; turn on transparency only if you want it.

### Start the relay server (terminal 1)

```powershell
cd server
npm.cmd install
$env:EDIT_KEY="YOUR_UNIQUE_OWNER_KEY"
$env:STREAM_KEY="YOUR_UNIQUE_PUBLISHING_KEY"
npm.cmd start
```

### Start the overlay (terminal 2)

```powershell
cd desktop-overlay
npm.cmd install
npm.cmd start
```

The overlay loads `http://localhost:8765/?overlay=1&role=view`. If the server is still starting, Electron retries automatically.

### Overlay controls

| Control | What it does |
|---|---|
| **Practice Mode** badge | Always visible |
| **Viewer** role | Read-only — for the other person |
| **Transparent** | Optional glass look (OFF by default) |
| Drag header | Move the frameless window |

> This is intentionally a **mock-interview training / accessibility overlay**. It does not hide from screen capture or attempt stealth behavior.

### Optional: custom viewer URL

```powershell
$env:OVERLAY_URL="http://localhost:8765/?overlay=1&role=view"
npm.cmd start
```

### Pack as a Windows app (share with a friend)

**Use the Setup installer (fast).** Portable `.exe` is slow because it unpacks ~85MB on every launch.

```powershell
cd desktop-overlay
npm.cmd install
npm.cmd run dist
```

Output:

`desktop-overlay/dist/LiveWorkspaceOverlay-Setup-1.0.0.exe`

**Friend steps:**
1. Run the Setup `.exe` **once** (installs + desktop shortcut)
2. Later opens are fast from the shortcut / Start Menu
3. Paste the view link if asked (`overlay=1`, `role=view`, `key=...`)
4. Click **Open Overlay**
5. Use **Transparent: ON** for the glass look

Optional slow portable build (not recommended for daily use):

```powershell
npm.cmd run dist:portable
```

> Guest viewers do **not** need `APP_PASSWORD`; they need owner approval.
> Owner access requires the existing password when configured, including owner read-only links.
> The Chrome extension stays on **your** PC only. The installed app is the viewer for the other person.

## 4. Deploy to Render (remote teammates)

### Push to GitHub

```powershell
git add .
git commit -m "Deploy Live Workspace"
git push
```

Do **not** commit `config.js` (it is gitignored).

### Deploy on Render

1. Sign up at [render.com](https://render.com)
2. **New +** → **Blueprint** → connect the repo
3. Set env vars:
   - `STREAM_KEY` (required on hosted — ingest fail-closed without it)
   - `EDIT_KEY` (required owner-only key, different from all other keys)
   - `VIEW_KEY` (legacy mode only; cannot bypass approval)
   - `VIEWER_APPROVAL_REQUIRED=true` (default)
   - `APP_PASSWORD` (owner password gate; guests use approved sessions)
   - `APP_ORIGIN=https://your-app.onrender.com` (required exact public origin)
   - optional SMTP vars
4. Copy your app URL

> Rotate any keys that were ever committed, pasted in chat, or baked into an old `.exe`.

### Update extension config

```js
var SERVER_URL = "https://your-app.onrender.com";
var STREAM_KEY = "your-stream-key";
```

Reload the extension.

> Free Render apps sleep after idle time. The extension wakes `/health` automatically; first hit after sleep can take 30–60s.

## 5. Alternative: ngrok

1. `npm start` in `server/`
2. `ngrok http 8765`
3. Set `APP_ORIGIN` to the HTTPS ngrok origin, restart the server, and share its `/access` page
4. Keep extension `SERVER_URL` on localhost if you only need remote viewers via tunnel

## How it works

| Component | Role |
|---|---|
| `content.js` | Detects answer changes, wakes server |
| `background.js` | POSTs answers, retries, offline queue |
| `popup` | Shows health / last sent / wake |
| `server.js` | `/answer` ingest + WebSocket broadcast |
| `viewer.html` | Live collaborator UI (+ overlay CSS when `?overlay=1`) |
| `desktop-overlay` | Electron transparent always-on-top shell |

## Troubleshooting

### Extension not detecting text

- DevTools Console → look for `[Live Workspace] ANSWER CHANGED`
- Reload extension + hard-refresh the chat tab

### Viewer connected but empty

- Turn **Auto Copy: ON**
- Confirm `config.js` `SERVER_URL` / `STREAM_KEY`
- Use extension popup → **Test server**

### Overlay is a blank / black window

- Confirm the server is running on port `8765`
- Open `http://localhost:8765/?overlay=1` in Chrome first
- Restart with `npm.cmd start` inside `desktop-overlay`

### `npm` blocked on Windows PowerShell

```powershell
npm.cmd install
npm.cmd start
```

## License

Private / personal use.

