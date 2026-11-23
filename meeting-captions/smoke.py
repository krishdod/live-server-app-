"""Exercise actual local recognition with a public WAV fixture, never a microphone."""
import json
import time
import wave
from pathlib import Path

from models import MODELS
from speech import CaptionStream


def recognize_fixture(directory, wav_path):
    from vosk import Model, SpkModel, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)
    began = time.monotonic()
    model = Model(str(Path(directory) / MODELS["english"][0]))
    speaker = SpkModel(str(Path(directory) / MODELS["speaker"][0]))
    packets = []
    with wave.open(str(wav_path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError("Fixture must be mono 16-bit PCM WAV.")
        rate = source.getframerate()
        recognizer = KaldiRecognizer(model, rate)
        recognizer.SetSpkModel(speaker)
        stream = CaptionStream(recognizer, packets.append, sample_rate=rate)
        duration = source.getnframes() / rate
        inference = time.monotonic()
        while pcm := source.readframes(rate // 10):
            stream.feed(pcm)
        stream.finish()
    final = [packet for packet in packets if packet["type"] == "final"]
    if not final:
        raise RuntimeError("Recognition produced no final phrases.")
    return {"audioSeconds": duration, "totalSeconds": round(time.monotonic() - began, 3),
            "inferenceSeconds": round(time.monotonic() - inference, 3), "packets": final}
