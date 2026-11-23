"""Windows development-only layout check; opens no audio recorder."""
import json
import sys
import time
import tkinter as tk
from pathlib import Path

if sys.platform != "win32":
    raise SystemExit("This screenshot check runs on Windows only.")
# Use the host's existing screenshot library; it is not a sender dependency.
sys.path.append(str(Path(sys.base_prefix) / "Lib" / "site-packages"))
from PIL import ImageGrab
from sender import SenderApp

root = Path(__file__).resolve().parent.parent
output = root / "artifacts" / "meeting-captions" / "ui"
output.mkdir(parents=True, exist_ok=True)
window = tk.Tk()
sender = SenderApp(window, "https://live-server-app.onrender.com", root / "artifacts" / "meeting-captions" / "caption-models")
deadline = time.monotonic() + 4
while sender.working and time.monotonic() < deadline:
    window.update()
    time.sleep(0.05)
window.update()
results = []
for height in (790, 650):
    window.geometry(f"720x{height}+50+50")
    window.update()
    time.sleep(0.15)
    window.update()
    x, y = window.winfo_rootx(), window.winfo_rooty()
    ImageGrab.grab(bbox=(x,y,x+window.winfo_width(),y+window.winfo_height())).save(output / f"sender-{height}.png")
    assert sender.stop.winfo_rooty() + sender.stop.winfo_height() <= y + window.winfo_height()
    assert sender.preview.winfo_height() >= 40
    results.append({"height":height,"previewHeight":sender.preview.winfo_height(),"devices":len(sender.devices)})
assert not sender.capturing
assert sender.devices, sender.capture_status.get()
(output / "sender-layout.json").write_text(json.dumps({"passed":True,"layouts":results},indent=2))
window.destroy()
