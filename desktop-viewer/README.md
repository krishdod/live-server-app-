# Live Workspace desktop viewer

A Windows and macOS companion that opens your existing Live Workspace answer
page in a window with capture exclusion enabled. The extension and server keep
working as before.

## Open the viewer

1. Open the built desktop app.
2. Choose **Open** to use `https://live-server-app.onrender.com/access`, or paste your server's
   `/access` address. A GitHub repository URL is not a viewer link.
3. Enter your name, request access, and give the displayed request code to the
   owner. Once approved, the live viewer opens automatically. Approval and login
   pages remain visible and clickable. The app has separate cookies from Chrome.
4. Confirm **Capture protection on** appears in the header.
5. Start a test screen share and have the person receiving it confirm what they
   see. Test the exact meeting app, capture mode, and monitor you plan to use.

The app makes no connection until you choose **Open**. The viewer link is not
saved between app sessions. Its query parameters are passed to your viewer
server as part of opening the link; the app does not need the extension's
`STREAM_KEY`.

## Controls

- **Always on Top** keeps the viewer above other windows (on by default). **Ctrl+Alt+T** toggles it (Control+Option+T on Mac).
- **Click-through** starts off so the viewer is clickable. Enable it in **Controls**, or press **Ctrl+Alt+C**, to click apps behind the page. The compact controls strip stays clickable. Approval and login pages always accept mouse input.
- **Background** + / − (or **Ctrl+Alt+=** / **Ctrl+Alt+-**) adjusts the glass surface from 20% to 100% opacity. It starts at 75%; words and code remain fully opaque. Approval and sign-in pages stay solid. Native background blur is requested on supported Windows 11 and macOS hosts; other hosts use plain translucency.
- After approval, the setup panel collapses into a 44px strip with **Controls** and **Close**. Choose **Controls** or press **Ctrl+Alt+B** for window settings; **Done** collapses them again. The visible button works even if the shortcut cannot register.
- The link box is shown at the start. After **Open**, that section is removed and the toolbar shrinks. **Link** brings the address box back.
- Approval keeps the viewer open and visible. Expired or revoked access returns to the visible request screen and restores the control panel.
- **Reload** reloads the current viewer page.
- **Hide** hides this window. **Ctrl+Alt+V** (Control+Option+V on Mac) brings it back or hides it again.
- **Close** exits the app.

The open app remains available from the Windows taskbar / macOS Dock. Hiding
requires an explicit **Hide** action or Ctrl+Alt+V. Launching the app again also
brings the existing window forward.

If another app already owns Ctrl+Alt+V, **Hide** is disabled and the header
reports that the shortcut is unavailable. The app remains available from the
taskbar or Dock.

## What protection covers

Capture exclusion requests that compatible screen-capture tools omit this app's
window (`setContentProtection` on Windows and macOS). It is not a guarantee that
nobody can tell an app is open. The process remains visible in Task Manager /
Activity Monitor. Other capture methods or devices can still reveal its
contents, and an incompatible capture method may show a black area or the
window itself.

Protection applies to this desktop window only. It does not protect the viewer
if it is also open in Chrome, the ChatGPT tab, Caption Copier, other windows,
system dialogs, or notifications. Close or minimize those windows before an
entire-screen share when they should not be included.

On Windows this companion requires Windows 10 version 2004 or newer. On macOS it
uses Electron content protection. It will not load the live page when capture
protection is unavailable. The header confirms that protection was enabled, not
that a particular meeting app has honored it. Verify the receiving view again
after changing your meeting app, capture settings, or operating system.

References:

- [Electron content protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows)
- [Windows display affinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)

## Local build

### Windows (this PC)

In this `desktop-viewer` folder, with Node.js and npm installed:

```powershell
npm.cmd ci
npm.cmd run dist
```

Open `dist-v8/LiveWorkspaceViewer-1.4.0-portable.exe`. The previous `dist-v7`
folder is preserved. Deploy the accompanying server update before sharing v5;
see [Viewer access setup](../VIEWER-ACCESS.md).

### macOS

A Mac `.app` / `.dmg` cannot be built on Windows. Double-click often fails
(Gatekeeper / WhatsApp). Use Terminal — this is the method that works.

1. Copy `Live-Workspace-Viewer-Mac.zip` to the Mac and unzip it.
2. Open **Terminal**, go into the folder that contains `Open Viewer.command`, then run:

```bash
xattr -cr .
chmod +x "Open Viewer.command"
bash "Open Viewer.command"
```

First run installs deps and may build the app; later runs launch faster.
Full notes: `mac-easy/HOW TO OPEN ON MAC.txt` (same text is inside the zip).

Manual build on a Mac (optional):

```bash
cd desktop-viewer
npm ci
npm run dist:mac
```

Then open the `.app` under `dist-v8/mac-arm64` or `dist-v8/mac`.

### Validation

`npm test` checks URL handling, renderer isolation, window recovery, and
protection failure paths. With the repository's server dependencies installed,
`npm run test:smoke` loads the real viewer against a temporary local
HTTP/WebSocket server. Neither check proves exclusion in a particular meeting
application.

`npm run test:approval-smoke` runs the real request page, owner dashboard,
server and desktop renderer together using only temporary local credentials.
It checks approval, formatted streaming, reconnect and revocation.

These files and build outputs are local. Building this companion does not
deploy changes to GitHub or the hosted relay server. Loading the hosted viewer
uses the version already deployed there; it does not upload local viewer fixes.
