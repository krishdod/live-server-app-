# Live Workspace desktop viewer

A compact, owner-approved live reading window for Windows and macOS. See [START-HERE](../START-HERE.md) for the full browser → server → app setup.

## Open the viewer

1. Close any older viewer with Close or End.
2. Run `releases/LiveWorkspaceViewer-1.5.1-portable.exe` on Windows.
3. Choose Open. The default page is `https://live-server-app.onrender.com/access`.
4. Enter your name and give the request code to the owner. The owner approves it in Viewer access.
5. The window stays visible after approval. A 44px control bar replaces the setup panel.

The app has separate cookies from Chrome. Approval lasts only for this app session; closing it requires a new request. It makes no network connection until Open is chosen. The browser extension publishes answers; this app reads them.

## Reading and controls

- **Connected** reflects the live page’s connection. **Reconnecting** means it is recovering; **Paused** means the owner switched Auto Copy off.
- **Copy** copies the current answer as readable Markdown text.
- **Clear** clears this window only. The next incoming answer appears automatically. Reload restores the server’s current answer.
- **Controls**, or **Ctrl+Alt+B**, opens settings. Done returns to the compact bar.
- **Taskbar / Dock** in Controls shows or hides the app icon. The icon hides by default after approval while the viewer window stays visible. Approval, sign-in and revoked-access screens show the icon again. This setting does not hide the process in Task Manager or Activity Monitor.
- **Background + / −**, or **Ctrl+Alt+= / Ctrl+Alt+-**, changes surface opacity from 20% to 100%. It starts at 65%. Text remains fully opaque. Windows uses plain translucency; macOS requests native blur.
- **Theme** switches light and dark reading surfaces.
- **Pin on top**, or **Ctrl+Alt+T**, keeps the app above normal windows.
- **Click-through**, or **Ctrl+Alt+C**, lets clicks pass to apps behind the answer. It starts off; the control bar stays clickable. Approval pages always accept input.
- **Reload** reconnects to the current page.
- **Hide**, or **Ctrl+Alt+V**, explicitly hides the window. Press the shortcut again or launch the app again to bring it back.
- **End / Close** closes the viewing session.

Use Control+Option for these shortcuts on macOS. If a shortcut is unavailable, the visible controls still work; Hide is disabled when its recovery shortcut cannot register. Launch the app again to bring back an existing hidden window, or enable Taskbar / Dock in Controls to restore its icon.

If the background is solid, confirm that an older app has been closed, finish approval, and check the percentage in the compact bar. Approval and sign-in forms intentionally stay solid.

## Capture protection

The app requests capture exclusion with Electron’s content protection API. Windows requires version 10 build 19041 or newer. The app does not load remote content when protection cannot be enabled.

Protection depends on the operating system, sharing app and capture method. It does not hide the process in Task Manager / Activity Monitor or protect Chrome, Caption Copier, system dialogs or other apps. Test the actual receiving view before relying on it. The automated tests verify the native protection flag, not a meeting receiver.

[Electron content protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows)

## Build

In this folder:

```powershell
npm.cmd ci
npm.cmd run dist
```

The Windows executable is written to `../releases/`.

On a Mac with Node.js, run `bash start-mac.command`, or `npm ci` then `npm start`. Build Mac installers on a Mac with `npm run dist:mac`; configure Developer ID signing before distributing signed builds. The packaged Mac source is not a signed installer; Mac runtime behavior has not been verified in this Windows environment.

## Verify

- `npm test`: URL, isolation, protection and window-control policies.
- `npm run test:smoke`: native rendering and streaming from a temporary local server.
- `npm run test:approval-smoke`: approval, live connection indicator, copying, local clearing, subsequent updates, themes, reload and revocation.
- `npm run test:transparency`: actual rendered pixels, clear host canvas, opaque text, light/dark surfaces, 40%/65%/100% opacity and resizing.

Tests use isolated local fixtures and fake keys. Screenshots and results are generated under `artifacts/`. Building an executable does not deploy the server.
