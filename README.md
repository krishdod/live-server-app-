# Live Workspace

Stream live text from your browser to a teammate in real time.

```
Your chat page
      ↓
content.js detects text changes
      ↓
background.js POSTs to relay server
      ↓
Teammate sees same text live
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
└── server/
    ├── server.js      # HTTP + WebSocket relay server
    ├── viewer.html    # Live viewer page for teammates
    └── package.json
```

## Requirements

- Google Chrome
- Node.js 18+ (for local server or Render deploy)

## Features

- Live streaming from ChatGPT / Perplexity
- Code blocks with highlighting + Copy
- Focus mode (full-width reading)
- Light / Dark theme
- Streaming / Paused badges
- Extension popup: server health, last sent, wake/test
- Offline queue if the server is briefly down
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
npm start
```

The server runs at `http://localhost:8765` (`/health` for wake checks).

### Configure the extension

In `config.js`:

```js
var SERVER_URL = "http://localhost:8765";
var STREAM_KEY = "";
```

Reload the extension at `chrome://extensions`.

### Share with a teammate on the same Wi‑Fi

1. Find your local IP:
   ```powershell
   ipconfig
   ```
2. Share: `http://YOUR-IP:8765`
3. Teammate opens that link

### Test

1. Open ChatGPT / Perplexity and ask a question
2. Open the viewer with **Auto Copy: ON**
3. Text should appear live; code stays formatted

## 3. Deploy to Render (remote teammates)

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
3. Set env vars if needed: `STREAM_KEY`, optional `EDIT_KEY` / `VIEW_KEY`, SMTP
4. Copy your app URL

### Update extension config

```js
var SERVER_URL = "https://your-app.onrender.com";
var STREAM_KEY = "your-stream-key";
```

Reload the extension.

> Free Render apps sleep after idle time. The extension wakes `/health` automatically; first hit after sleep can take 30–60s.

## 4. Alternative: ngrok

1. `npm start` in `server/`
2. `ngrok http 8765`
3. Share the ngrok URL for the viewer
4. Keep extension `SERVER_URL` on localhost if you only need remote viewers via tunnel

## How it works

| Component | Role |
|-----------|------|
| `content.js` | Detects answer changes, wakes server |
| `background.js` | POSTs answers, retries, offline queue |
| `popup` | Shows health / last sent / wake |
| `server.js` | `/answer` ingest + WebSocket broadcast |
| `viewer.html` | Live collaborator UI |

## Troubleshooting

### Desktop viewer with screen-capture exclusion (Windows and macOS)

The separate desktop companion and instructions are in
[`desktop-viewer/README.md`](desktop-viewer/README.md). It opens the existing
live viewer link, requests capture exclusion on Windows and macOS, and provides Ctrl+Alt+V
to hide or restore the window. It stays off the taskbar when that recovery
shortcut is available. Test the receiving side of the actual screen share:
this does not hide Chrome, other apps, or the process in Task Manager, and
it is not a guarantee against every capture method. The v5 approval flow needs
the matching server update deployed first; see [Viewer access](VIEWER-ACCESS.md).

### Chrome address-bar paste and answer formatting

The rebuilt desktop app and activation steps are in
[`caption-copier-fix/START-HERE.md`](caption-copier-fix/START-HERE.md).
Extension 5.3 preserves Markdown from ChatGPT. The updated local viewer renders
headings, emphasis, lists, tables, and code while streaming, using bundled
Marked and DOMPurify scripts. The hosted server needs these viewer changes
deployed separately.

### Caption Copier sends to ChatGPT, but the viewer stays empty

Caption Copier only handles pasting/submitting the prompt. This extension picks
up the assistant answer and sends it to the server configured in `config.js`.

1. In `chrome://extensions`, reload **Live Workspace** from this folder, then
   refresh the ChatGPT tab. Both are needed after an extension update.
2. Open the extension popup and choose **Test answer delivery**. This checks
   `/answer` with the configured key without changing the displayed answer.
   **Online** alone only means `/health` is reachable.
3. If the popup says **Key rejected**, make `STREAM_KEY` in `config.js` match the
   server's `STREAM_KEY`, then reload the extension and refresh ChatGPT again.
4. Submit a new caption. **Last captured** should update, followed by
   **Answer accepted** and **Last sent**. If nothing is captured, confirm that
   the extension has access to the ChatGPT site and the tab was refreshed.
5. Open the viewer at the same server address (using your viewer/editor access
   link if enabled). Check **Connected** and **Auto Copy: ON**. The popup's
   **Viewers connected** count should increase.

The extension now selects the newest assistant reply, understands compact
stream updates, and saves the newest unsent answer across background worker
restarts. The local viewer now takes its Auto Copy setting from the server;
opening another viewer cannot switch streaming off. Resuming Auto Copy replays
the newest response completed while paused.

**Hosted server:** changing these local files does not update Render. The owner
approval update now includes the hosted password gate and the streaming fixes.
See [Viewer access setup](VIEWER-ACCESS.md) for activation, owner controls, and
the free-host restart limits. Deploy the server update before distributing the
new desktop viewer.

### Run the regression checks

Install server dependencies with `npm.cmd ci --prefix server`, then run
`npm.cmd test` from the project root. Tests use fake extension credentials and
temporary local HTTP/WebSocket servers; they do not send to the hosted viewer.

### Extension not detecting text

- DevTools Console → look for `[Live Workspace] ANSWER CHANGED`
- Reload extension + hard-refresh the chat tab

### Viewer connected but empty

- Turn **Auto Copy: ON**
- Confirm `config.js` `SERVER_URL` / `STREAM_KEY`
- Use extension popup → **Test answer delivery**

### `npm` blocked on Windows PowerShell

```powershell
npm.cmd install
npm.cmd start
```

## License

Private / personal use.
