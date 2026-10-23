"""Package current sources only. Credentials, caches and historical builds are excluded."""
from pathlib import Path
import json
import shutil
import zipfile

root = Path(__file__).resolve().parents[1]
output = root / "releases"
output.mkdir(exist_ok=True)
extension_version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
desktop = root / "desktop-viewer"
desktop_version = json.loads((desktop / "package.json").read_text(encoding="utf-8"))["version"]
extension_files = ["manifest.json", "background.js", "content.js", "page-hook.js", "popup.html", "popup.js", "popup.css", "server/markdown.js"]
viewer_files = ["main.js", "app-icon.js", "policy.js", "appearance.js", "glass.css", "preload.js", "home.html", "home.js", "home.css", "package.json", "package-lock.json", "start-mac.command", "README.md"]

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

package(f"LiveWorkspace-extension-{extension_version}.zip", root, extension_files,
        "Extract into a permanent folder. Open chrome://extensions, enable Developer mode, and choose Load unpacked.\n"
        "Select the extracted folder. Open the extension popup > Connection settings.\n"
        "Set https://live-server-app.onrender.com and paste STREAM_KEY from your own Render service. Save, then Test delivery.\n"
        "Refresh ChatGPT and ask a new question. Never share your publishing key.\n")
package(f"LiveWorkspaceViewer-{desktop_version}-mac-source.zip", desktop, viewer_files,
        "SOURCE PACKAGE, not a signed Mac installer. Install Node.js, open Terminal in this folder, and run bash start-mac.command.\n"
        "The first launch installs the pinned dependencies. Mac runtime behavior must be verified on a Mac.\n")
shutil.copy2(root / "START-HERE.md", output / "START-HERE.md")
