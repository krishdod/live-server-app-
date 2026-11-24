"""One-time model setup. Recognition itself makes no network requests."""
import hashlib
import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

MODELS = {
    "english": ("vosk-model-small-en-us-0.15", "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498"),
    "speaker": ("vosk-model-spk-0.4", "a74d8f51144484813e16af689bb0f916b7a111e2347f467c4933c1166097b5a7"),
}


def default_directory():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "LiveWorkspace" / "caption-models"
    return Path.home() / "Library" / "Application Support" / "LiveWorkspace" / "caption-models"


def ready(directory):
    root = Path(directory)
    return (root / MODELS["english"][0] / "am" / "final.mdl").is_file() and (root / MODELS["speaker"][0] / "final.ext.raw").is_file()


def install(directory, report=lambda text: None):
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    for name, expected in MODELS.values():
        target = root / name
        if target.exists():
            continue
        with tempfile.TemporaryDirectory(dir=root) as staging:
            archive = Path(staging) / "model.zip"
            report(f"Downloading {name}…")
            with urllib.request.urlopen(f"https://alphacephei.com/vosk/models/{name}.zip", timeout=30) as response, archive.open("wb") as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 100 * 1024 * 1024:
                        raise RuntimeError("Model download is larger than expected.")
                    output.write(chunk)
            with archive.open("rb") as downloaded:
                if hashlib.file_digest(downloaded, "sha256").hexdigest() != expected:
                    raise RuntimeError("Model checksum failed. Try downloading again.")
            with zipfile.ZipFile(archive) as bundle:
                if sum(member.file_size for member in bundle.infolist()) > 250 * 1024 * 1024:
                    raise RuntimeError("Model archive is larger than expected.")
                for member in bundle.infolist():
                    destination = (Path(staging) / member.filename).resolve()
                    if not destination.is_relative_to(Path(staging).resolve()) or (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise RuntimeError("Unsafe model archive.")
                bundle.extractall(staging)
            shutil.move(str(Path(staging) / name), str(target))
    if not ready(root):
        raise RuntimeError("Model files are incomplete. Remove the incomplete model folder and retry setup.")
    report("English and speaker models ready. You can now pair and start captions.")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=default_directory())
    install(parser.parse_args().directory, print)
