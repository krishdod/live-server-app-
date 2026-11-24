"""Build a sender with Python, native speech libraries and both models included."""
import argparse
import platform
import importlib.metadata
import shutil
import subprocess
import sys
from pathlib import Path
from models import install, ready

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--models", type=Path, default=ROOT.parent / "artifacts" / "meeting-captions" / "caption-models")
options = parser.parse_args()
if not ready(options.models):
    install(options.models, print)
name = "MeetingCaptionSender-0.1.0-preview"
licenses = ROOT.parent / "artifacts" / "meeting-captions" / "third-party-licenses"
licenses.mkdir(parents=True, exist_ok=True)
for distribution in importlib.metadata.distributions():
    for file in distribution.files or []:
        if any(part in file.name.lower() for part in ("license", "copying", "notice")):
            source = Path(distribution.locate_file(file))
            if source.is_file():
                target = licenses / distribution.metadata["Name"] / file.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
python_license = Path(sys.base_prefix) / "LICENSE.txt"
if python_license.is_file():
    shutil.copyfile(python_license, licenses / "PYTHON-LICENSE.txt")
command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--windowed", "--name", name,
           "--distpath", str(ROOT.parent / "releases"), "--workpath", str(ROOT.parent / "artifacts" / "meeting-captions" / "build"),
           "--specpath", str(ROOT.parent / "artifacts" / "meeting-captions"),
           "--collect-all", "vosk", "--collect-all", "soundcard", "--hidden-import", "_cffi_backend",
           "--add-data", f"{options.models.resolve()}:caption-models",
           "--add-data", f"{ROOT / 'THIRD-PARTY-NOTICES.txt'}:.",
           "--add-data", f"{licenses}:third-party-licenses",
           "--add-data", f"{ROOT / 'APACHE-2.0.txt'}:."]
if sys.platform == "win32":
    command += ["--onefile"]
elif sys.platform == "darwin":
    command += ["--onedir", "--osx-bundle-identifier", "com.liveworkspace.meetingcaptions"]
    # The microphone entitlement/usage description is needed even for a
    # virtual CoreAudio input such as BlackHole. No permissions are bypassed.
    command += ["--osx-entitlements-file", str(ROOT / "entitlements.mac.plist")]
else:
    raise SystemExit("Recipient builds support Windows and macOS.")
command += [str(ROOT / "sender.py")]
subprocess.run(command, cwd=ROOT, check=True)
if sys.platform == "darwin":
    import plistlib
    info = ROOT.parent / "releases" / f"{name}.app" / "Contents" / "Info.plist"
    with info.open("rb") as source:
        data = plistlib.load(source)
    data["NSMicrophoneUsageDescription"] = "Capture the meeting audio source you select to create captions locally. Only transcript text is shared with your paired helper."
    with info.open("wb") as output:
        plistlib.dump(data, output)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", "--entitlements", str(ROOT / "entitlements.mac.plist"), str(info.parents[1])], check=True)
print(f"Built {name} for {platform.system()} {platform.machine()}")
