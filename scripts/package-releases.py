"""Package current sources only. Credentials, caches and historical builds are excluded."""
from pathlib import Path
import json
import shutil
import zipfile
import argparse
import hashlib

parser = argparse.ArgumentParser()
parser.add_argument("--viewer-only", action="store_true")
args = parser.parse_args()

root = Path(__file__).resolve().parents[1]
output = root / "releases"
output.mkdir(exist_ok=True)
extension_version = None if args.viewer_only else json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
desktop = root / "desktop-viewer"
desktop_version = json.loads((desktop / "package.json").read_text(encoding="utf-8"))["version"]
extension_files = ["manifest.json", "background.js", "content.js", "page-hook.js", "popup.html", "popup.js", "popup.css", "server/markdown.js"]

def package(name, base, files, instructions):
    target = output / name
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for relative in files:
            archive.write(base / relative, relative)
        archive.writestr("INSTALL.txt", instructions)
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert not any(Path(name).name in {"config.js", ".env"} for name in archive.namelist())
        assert all(name in archive.namelist() for name in files)
    print(target.name)

if not args.viewer_only:
    package(f"LiveWorkspace-extension-{extension_version}.zip", root, extension_files,
        "Extract into a permanent folder. Open chrome://extensions, enable Developer mode, and choose Load unpacked.\n"
        "Select the extracted folder. Open the extension popup > Connection settings.\n"
        "Set https://live-server-app.onrender.com and paste STREAM_KEY from your own Render service. Save, then Test delivery.\n"
        "Refresh ChatGPT and ask a new question. Never share your publishing key.\n")
shutil.copy2(root / "START-HERE.md", output / "START-HERE.md")
executable = output / f"LiveWorkspaceViewer-{desktop_version}-setup.exe"
if not executable.exists():
    executable = output / f"LiveWorkspaceViewer-{desktop_version}-portable.exe"
recipient_notes = output / "RECIPIENT-START-HERE.txt"
recipient_notes.write_text(
    f"LIVE WORKSPACE VIEWER {desktop_version}\n\n"
    "WINDOWS\nClose any older viewer. Run the setup EXE, then open Live Workspace Viewer.\n"
    "The portable EXE is an alternative if you do not want an installation.\n\n"
    "MAC\nUse the bundled universal DMG from the macOS build workflow. Drag the app to Applications.\n"
    "A Mac source ZIP is not a recipient app. Test builds are ad-hoc signed, not Apple-notarized.\n\n"
    "The runtime and server address are built in. No Node installation, Terminal or URL entry is needed.\n"
    "An internet connection is required. The access page opens automatically.\n"
    "Enter your name, request access, and send the displayed code to the owner.\n"
    "Approval in Chrome does not approve the app's separate session.\n"
    "After approval the window stays visible and shows live answers.\n\n"
    "IF CONNECTION FAILS\nThe app retries temporary failures automatically. Choose Retry connection if needed.\n"
    "Choose Copy error details and send the copied text to the owner. It includes only app/OS versions,\n"
    "error codes, a proxy classification, and the health check HTTP status; no keys, cookies or answers.\n\n"
    "CONTROLS\nControls opens settings. Copy copies the answer; Clear affects only this window.\n"
    "Ctrl+Alt+V hides/restores the window; use Control+Option on Mac. End closes the session.\n"
    "Capture protection depends on the OS and sharing method. Test the receiving view.\n"
    "The process remains visible in Task Manager / Activity Monitor.\n",
    encoding="utf-8")
if executable.exists():
    package(f"LiveWorkspaceViewer-{desktop_version}-share.zip", output, [executable.name, recipient_notes.name],
            "Extract the ZIP, read RECIPIENT-START-HERE.txt, then run the setup EXE.\n")
checksum_name = f"LiveWorkspaceViewer-{desktop_version}-SHA256SUMS.txt"
release_files = sorted(p for p in output.glob(f"LiveWorkspaceViewer-{desktop_version}-*") if p.is_file() and p.name != checksum_name)
checksums = []
for release in release_files:
    with release.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    checksums.append(f"{digest}  {release.name}\n")
(output / checksum_name).write_text("".join(checksums), encoding="utf-8")
