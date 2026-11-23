"""Meeting Caption Sender: explicit local capture, local English ASR, text-only relay."""
import argparse
import contextlib
import ctypes
import queue
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import ttk, messagebox

from models import MODELS, default_directory, install, ready
from speech import CaptionStream, SpeakerTracker
from transport import DEFAULT_SERVER, RelayError, TextSender, request_json, server_origin


@contextlib.contextmanager
def audio_thread():
    initialized = False
    if sys.platform == "win32":
        initialized = ctypes.windll.ole32.CoInitializeEx(None, 0) in (0, 1)
    try:
        yield
    finally:
        if initialized:
            ctypes.windll.ole32.CoUninitialize()


class SenderApp:
    def __init__(self, root, server, directory):
        self.root, self.server, self.directory = root, server_origin(server), directory
        self.events = queue.Queue()
        self.stop_event = threading.Event()
        self.devices = []
        self.sender = None
        self.capturing = False
        self.working = False
        self.tracker = SpeakerTracker()
        self.elapsed_ms = 0
        self.capture_error = False
        # SoundCard initializes its process-wide COM helper at import time.
        # Import on the UI thread once, then initialize COM in each worker.
        try:
            import soundcard
            self.audio_backend = soundcard
            self.audio_error = ""
        except Exception as error:
            self.audio_backend = None
            self.audio_error = str(error)
        root.title("Meeting Caption Sender")
        root.geometry(f"720x{min(790, root.winfo_screenheight() - 100)}")
        root.minsize(600, 650)
        style = ttk.Style()
        if "clam" in style.theme_names():
            style.theme_use("clam")
        root.configure(background="#0b100d")
        style.configure("TFrame", background="#0b100d")
        style.configure("TLabel", font=("Segoe UI", 11), background="#0b100d", foreground="#eef5f0")
        style.configure("TButton", padding=(14, 9), font=("Segoe UI", 10), background="#1d2a22", foreground="#eef5f0", bordercolor="#2c3a31")
        style.map("TButton", background=[("active", "#2c3a31")], foreground=[("disabled", "#a2b2a7")])
        style.configure("Primary.TButton", background="#79e5a2", foreground="#102719")
        style.map("Primary.TButton", background=[("disabled", "#1d2a22"), ("active", "#a0f2bf")], foreground=[("disabled", "#a2b2a7")])
        style.configure("TEntry", padding=8, fieldbackground="#131b16", foreground="#eef5f0", insertcolor="#79e5a2", bordercolor="#2c3a31")
        style.configure("TCheckbutton", background="#0b100d", foreground="#eef5f0", font=("Segoe UI", 10))
        style.map("TCheckbutton", background=[("active", "#131b16")])
        style.configure("TCombobox", padding=8, fieldbackground="#131b16", foreground="#eef5f0", background="#1d2a22", bordercolor="#2c3a31", arrowcolor="#eef5f0")
        style.map("TCombobox", fieldbackground=[("readonly", "#131b16")], foreground=[("readonly", "#eef5f0")])
        root.option_add("*TCombobox*Listbox.background", "#131b16")
        root.option_add("*TCombobox*Listbox.foreground", "#eef5f0")
        main = ttk.Frame(root, padding=24)
        main.pack(fill="both", expand=True)
        ttk.Label(main, text="Share the conversation", font=("Segoe UI", 21, "bold")).pack(anchor="w")
        ttk.Label(main, text="English captions run on this computer. Only text goes to your helper.", wraplength=640).pack(anchor="w", pady=(10, 20))
        self.model_status = tk.StringVar(value="Models ready" if ready(directory) else "First time: download the English and speaker models (~54 MB).")
        ttk.Label(main, textvariable=self.model_status, wraplength=640).pack(anchor="w")
        self.setup = ttk.Button(main, text="Set up offline models", command=self.setup_models)
        if not ready(directory):
            self.setup.pack(anchor="w", pady=(8, 20))
        form = ttk.Frame(main)
        form.pack(fill="x")
        form.columnconfigure(0, weight=1)
        form.columnconfigure(1, weight=1)
        ttk.Label(form, text="Your name").grid(row=0, column=0, sticky="w")
        ttk.Label(form, text="Pairing code from your helper").grid(row=0, column=1, sticky="w", padx=(16, 0))
        self.name, self.code = tk.StringVar(), tk.StringVar()
        ttk.Entry(form, textvariable=self.name).grid(row=1, column=0, sticky="ew", pady=(8, 12))
        self.code_entry = ttk.Entry(form, textvariable=self.code)
        self.code_entry.grid(row=1, column=1, sticky="ew", padx=(16, 0), pady=(8, 12))
        self.pair_button = ttk.Button(main, text="Pair with helper", command=self.pair, style="Primary.TButton")
        self.pair_button.pack(anchor="w", pady=(0, 18))
        ttk.Label(main, text="Meeting audio source").pack(anchor="w")
        source = ttk.Frame(main)
        source.pack(fill="x", pady=(8, 8))
        self.device = ttk.Combobox(source, state="readonly")
        self.device.pack(side="left", fill="x", expand=True)
        self.refresh = ttk.Button(source, text="Refresh", command=self.refresh_devices)
        self.refresh.pack(side="right", padx=(10, 0))
        hint = "Choose the output used by your meeting (headphones or speakers)."
        if sys.platform == "darwin":
            hint = "Route meeting output through BlackHole, then select BlackHole here. Allow microphone access for the app."
        ttk.Label(main, text=hint, wraplength=640).pack(anchor="w", pady=(0, 16))
        self.include_mic = tk.BooleanVar(value=False)
        self.mic_check = ttk.Checkbutton(main, text="Include my microphone (system default)", variable=self.include_mic)
        self.mic_check.pack(anchor="w", pady=(0, 14))
        controls = ttk.Frame(main)
        controls.pack(fill="x")
        self.start = ttk.Button(controls, text="Start captions", command=self.start_capture, state="disabled", style="Primary.TButton")
        self.start.pack(side="left")
        self.stop = ttk.Button(controls, text="Stop captions", command=self.stop_capture, state="disabled")
        self.stop.pack(side="left", padx=10)
        self.capture_status = tk.StringVar(value="Not listening. Pair and choose Start captions when ready.")
        ttk.Label(main, textvariable=self.capture_status, wraplength=640).pack(anchor="w", pady=(16, 6))
        self.delivery = tk.StringVar(value="Not paired")
        ttk.Label(main, textvariable=self.delivery, wraplength=640).pack(anchor="w", pady=(0, 12))
        self.preview = tk.Text(main, height=5, wrap="word", font=("Segoe UI", 12), padx=14, pady=12, state="disabled", background="#131b16", foreground="#eef5f0", insertbackground="#79e5a2", relief="flat", highlightthickness=1, highlightbackground="#2c3a31")
        self.preview.pack(fill="both", expand=True)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(100, self.drain_events)
        self.refresh_devices()

    def report(self, kind, text):
        self.events.put((kind, text))

    def controls(self):
        self.start["state"] = "normal" if self.sender and not self.sender.failed and not self.capturing and not self.working and ready(self.directory) and self.devices else "disabled"
        self.stop["state"] = "normal" if self.capturing else "disabled"
        for button in (self.pair_button, self.setup, self.refresh):
            button["state"] = "disabled" if self.capturing or self.working else "normal"
        self.device["state"] = "disabled" if self.capturing else "readonly"
        self.mic_check["state"] = "disabled" if self.capturing else "normal"

    def task(self, work):
        if self.working or self.capturing:
            return
        self.working = True
        self.controls()
        def run():
            try:
                work()
            except Exception as error:
                self.report("error", str(error))
            finally:
                self.report("idle", "")
        threading.Thread(target=run, daemon=True).start()

    def setup_models(self):
        self.task(lambda: install(self.directory, lambda text: self.report("models", text)))

    def refresh_devices(self):
        def work():
            with audio_thread():
                sc = self.audio_backend
                if sc is None:
                    raise RuntimeError(f"Audio support could not start. Restart the app. {self.audio_error}")
                devices = sc.all_microphones(include_loopback=True)
                if sys.platform == "win32":
                    devices = [d for d in devices if d.isloopback]
                    default_id = sc.default_speaker().id
                    devices.sort(key=lambda device: device.id != default_id)
                elif sys.platform == "darwin":
                    devices = [d for d in devices if "blackhole" in d.name.lower()]
                self.report("devices", [(d.id, d.name) for d in devices])
        self.task(work)

    def pair(self):
        code, name = self.code.get().strip(), self.name.get().strip()
        if not code or not name:
            messagebox.showinfo("Pair with helper", "Enter your name and the pairing code from your helper.")
            return
        def work():
            response = request_json(self.server, "/api/transcripts/pair", {"code": code, "name": name})
            self.report("paired", response)
        self.task(work)

    def emit(self, packet):
        self.sender.submit(packet)
        if packet["type"] in ("draft", "final"):
            prefix = "Draft" if packet["type"] == "draft" else packet["speaker"].replace("speaker-", "Speaker ").capitalize()
            self.report("preview", f"{prefix}: {packet['text']}")

    def start_capture(self):
        index = self.device.current()
        if index < 0 or not self.sender or self.capturing:
            return
        device_id = self.devices[index][0]
        self.capturing = True
        self.capture_error = False
        self.stop_event.clear()
        self.controls()
        self.capture_status.set("Loading local models…")
        threading.Thread(target=self.capture, args=(device_id, self.include_mic.get()), daemon=True).start()

    def capture(self, device_id, include_mic=False):
        streams = {}
        audio = queue.Queue(maxsize=40 if include_mic else 20)
        readers = []
        try:
            import numpy as np
            from vosk import Model, SpkModel, KaldiRecognizer, SetLogLevel
            SetLogLevel(-1)
            model = Model(str(self.directory / MODELS["english"][0]))
            speaker = SpkModel(str(self.directory / MODELS["speaker"][0]))
            for channel in (["meeting", "local"] if include_mic else ["meeting"]):
                recognizer = KaldiRecognizer(model, 48000)
                if channel == "meeting":
                    recognizer.SetSpkModel(speaker)
                stream = CaptionStream(recognizer, self.emit, speaker_override="local" if channel == "local" else None)
                stream.tracker = self.tracker
                stream.samples = round(self.elapsed_ms * 48)
                stream.start = self.elapsed_ms
                streams[channel] = stream
            self.sender.submit({"type": "status", "state": "listening"})
            def read_audio(channel, reader_done):
                try:
                    with audio_thread():
                        sc = self.audio_backend
                        source = sc.get_microphone(id=device_id, include_loopback=True) if channel == "meeting" else sc.default_microphone()
                        if channel == "local" and (source is None or "blackhole" in source.name.lower() or getattr(source,"isloopback",False)):
                            raise RuntimeError("Choose a physical microphone as the system default before including your voice.")
                        # Record all native channels, then mix to mono. WASAPI
                        # single-channel capture can return invalid samples.
                        with source.recorder(samplerate=48000, blocksize=9600) as recorder:
                            self.report("capture", "Listening locally · speaker labels appear after a phrase finishes")
                            while not self.stop_event.is_set():
                                block = recorder.record(numframes=4800)
                                mono = np.nan_to_num(block.mean(axis=1), nan=0.0)
                                pcm = (np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes()
                                try:
                                    audio.put_nowait((channel, pcm))
                                except queue.Full:
                                    raise RuntimeError("This computer cannot keep up with live speech. Captions stopped; close other apps before retrying.")
                except Exception as error:
                    self.report("error", f"Audio capture stopped: {error}")
                    self.stop_event.set()
                finally:
                    reader_done.set()
            for channel in streams:
                done = threading.Event()
                readers.append(done)
                threading.Thread(target=read_audio, args=(channel,done), daemon=True).start()
            heartbeat = time.monotonic()
            while not all(done.is_set() for done in readers) or not audio.empty():
                try:
                    channel, pcm = audio.get(timeout=0.3)
                    streams[channel].feed(pcm)
                except queue.Empty:
                    continue
                if self.sender.failed:
                    raise RelayError("Helper session ended. Pair a new session.")
                if time.monotonic() - heartbeat > 5:
                    self.sender.submit({"type": "status", "state": "listening"})
                    heartbeat = time.monotonic()
            for stream in streams.values():
                stream.finish()
            self.sender.submit({"type": "status", "state": "stopped"})
        except Exception as error:
            self.report("error", str(error))
        finally:
            if streams:
                self.elapsed_ms = max(round(stream.samples / 48) for stream in streams.values())
            self.stop_event.set()
            self.report("stopped", "Stopped · queued phrases will finish sending while this window stays open")

    def stop_capture(self):
        self.stop_event.set()
        self.stop["state"] = "disabled"
        self.capture_status.set("Stopping capture and finishing the last phrase…")

    def drain_events(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "idle":
                    self.working = False
                elif kind == "devices":
                    self.devices = value
                    self.device["values"] = [name for _, name in value]
                    if value:
                        self.device.current(0)
                    else:
                        self.capture_status.set("No meeting output found. Connect an audio device; on Mac, set up BlackHole and refresh.")
                elif kind == "paired":
                    if self.sender:
                        self.sender.close()
                    self.sender = TextSender(self.server, value["token"], self.report)
                    self.tracker = SpeakerTracker()
                    self.elapsed_ms = 0
                    self.code.set("")
                    self.delivery.set("Paired · choose Start captions when the meeting is ready")
                elif kind in ("capture", "stopped"):
                    if not self.capture_error:
                        self.capture_status.set(value)
                    if kind == "stopped":
                        self.capturing = False
                elif kind == "fatal":
                    self.stop_event.set()
                    self.delivery.set(value)
                elif kind == "error":
                    self.capture_error = True
                    self.capture_status.set(value)
                elif kind == "models":
                    self.model_status.set(value)
                    if ready(self.directory):
                        self.setup.pack_forget()
                elif kind == "delivery":
                    self.delivery.set(value)
                elif kind == "preview":
                    self.preview["state"] = "normal"
                    self.preview.delete("1.0", "end")
                    self.preview.insert("1.0", value)
                    self.preview["state"] = "disabled"
                self.controls()
        except queue.Empty:
            pass
        self.root.after(100, self.drain_events)

    def close(self):
        if self.capturing:
            self.stop_capture()
            messagebox.showinfo("Finish captions", "Captions are stopping. Wait for Stopped before closing so the last phrase can finish.")
            return
        if self.sender and self.sender.pending() and not messagebox.askyesno("Unsent captions", "Some phrases have not reached your helper. Close and discard these unsent phrases?"):
            return
        if self.sender:
            self.sender.close()
        self.root.destroy()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default=DEFAULT_SERVER)
    bundled = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "caption-models"
    parser.add_argument("--models", type=Path, default=bundled if ready(bundled) else default_directory())
    parser.add_argument("--self-test", type=Path, help="Recognize a mono PCM WAV fixture without capturing live audio")
    parser.add_argument("--result", type=Path, help="Write self-test results to this file")
    parser.add_argument("--ui-check", type=Path, help="Check bundled window startup without capturing audio")
    options = parser.parse_args()
    if options.self_test:
        import json
        from smoke import recognize_fixture
        result = recognize_fixture(options.models, options.self_test)
        if options.result:
            options.result.write_text(json.dumps(result, indent=2), encoding="utf-8")
        else:
            print(json.dumps(result))
        sys.exit(0)
    root = tk.Tk()
    instance = SenderApp(root, options.server, options.models)
    if options.ui_check:
        import json
        began = time.monotonic()
        def check_ui():
            if instance.working and time.monotonic() - began < 10:
                root.after(100, check_ui)
                return
            passed = ready(options.models) and instance.audio_backend is not None and not instance.working and not instance.capturing
            options.ui_check.write_text(json.dumps({"passed":passed,"modelsReady":ready(options.models),"captureStarted":instance.capturing,"devices":len(instance.devices),"error":instance.audio_error},indent=2),encoding="utf-8")
            root.destroy()
            if not passed:
                raise SystemExit(1)
        root.after(200, check_ui)
    root.mainloop()
