# Live Workspace — start here

## Connect the browser extension

1. Open `chrome://extensions`. Reload **Live Workspace** if it is already installed. For a new installation, turn on Developer mode, choose Load unpacked, and select this project folder or the extracted extension package.
2. Refresh the ChatGPT tab after reloading the extension.
3. Open the extension popup, then **Connection settings**.
4. Set the server to `https://live-server-app.onrender.com` — no `/access` at the end.
5. Paste **STREAM_KEY** from your Render service’s Environment settings into **Publishing key**. Choose **Save connection**, then **Test delivery**.
6. Continue when the popup says **Key accepted**. **Online** alone does not verify the key.

Connection settings are stored on this computer. The key is never included in release packages. An existing `config.js` remains supported, but saved popup settings take precedence. Changing servers clears any old queued answer so it is not sent to a different workspace.

## Open the app

1. Close an older viewer with **Close** or **End**.
2. Run `releases/LiveWorkspaceViewer-1.6.0-setup.exe` on Windows. A portable EXE is also available.
3. The access page opens automatically. Enter a name and request access. The server address and runtime are included; recipients install no Node.js and enter no URL.
4. Give your request code to the owner. The owner approves it at `https://live-server-app.onrender.com/access-admin`.
5. After approval, the viewer window remains visible and switches to its compact reading view; its taskbar/Dock icon hides. Enable **Taskbar / Dock** in Controls to show the icon again. **Connected** indicates the live connection. **Paused** means the owner needs to turn Auto Copy on.
6. Ask a new question in ChatGPT. The popup should update **Last captured** and **Last delivered**, and the answer should appear in the app.

**Copy** copies the answer. **Clear** clears this window only; the next answer appears automatically. **Controls** opens background, theme, pinning, click-through and reload controls. **End** closes the session. Ctrl+Alt+B opens settings; Ctrl+Alt+V explicitly hides or restores the window. Approval pages stay solid and clickable.

The app requests capture exclusion, but protection varies with the operating system, meeting app and capture method. Test with the person receiving your screen share. The process remains visible in Task Manager or Activity Monitor.

## Publish the server changes

Server dependency updates take effect after deployment. Deploy the reviewed commit in Render. Root directory: `server`; build command: `npm ci`; start command: `npm start`; Node version: 26 LTS. Keep one server instance. Set `APP_ORIGIN=https://live-server-app.onrender.com`, `VIEWER_APPROVAL_REQUIRED=true`, a private `EDIT_KEY`, and a separate `STREAM_KEY`. Keep your existing optional app password and mail settings.

For macOS, use the universal DMG or bundled app ZIP from the **Build desktop viewer** GitHub Actions workflow. It builds on macOS for both Intel and Apple Silicon; the recipient needs no Node.js or Terminal. The workflow's test builds use ad-hoc signing. Apple Developer ID signing and notarization are still needed for normal public distribution under Gatekeeper. The old `mac-source.zip` downloads are development source, not recipient installers.

If the app cannot connect, temporary failures retry automatically. Choose **Retry connection** if needed, then **Copy error details**. The copied report checks the app's own proxy route and server health without including keys, cookies, local paths or answer text.
