"""Local streaming recognition. Audio and speaker embeddings never leave this process."""
import json
import math


class SpeakerTracker:
    """Conservative utterance-level clustering, not word-level diarization."""
    def __init__(self, threshold=0.45, max_speakers=8):
        self.threshold = threshold
        self.max_speakers = max_speakers
        self.centers = []

    def identify(self, vector, frames):
        if not isinstance(vector, list) or len(vector) != 128 or frames < 150:
            return "unknown"
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in vector):
            return "unknown"
        norm = math.sqrt(sum(x * x for x in vector))
        if norm < 1e-9:
            return "unknown"
        unit = [x / norm for x in vector]
        distances = sorted((1 - sum(a * b for a, b in zip(unit, center)), i)
                           for i, center in enumerate(self.centers))
        if distances and distances[0][0] <= self.threshold:
            if len(distances) > 1 and distances[1][0] - distances[0][0] < 0.06:
                return "unknown"
            index = distances[0][1]
            # Adapt slowly so one noisy phrase does not rewrite a speaker.
            center = [0.95 * a + 0.05 * b for a, b in zip(self.centers[index], unit)]
            length = math.sqrt(sum(x * x for x in center))
            self.centers[index] = [x / length for x in center]
        elif len(self.centers) < self.max_speakers:
            index = len(self.centers)
            self.centers.append(unit)
        else:
            return "unknown"
        return f"speaker-{index + 1}"


class CaptionStream:
    def __init__(self, recognizer, emit, sample_rate=48000, speaker_override=None):
        self.recognizer = recognizer
        self.emit = emit
        self.rate = sample_rate
        self.samples = 0
        self.start = 0
        self.last_partial = ""
        self.tracker = SpeakerTracker()
        self.speaker_override = speaker_override

    def result(self, value):
        text = str(value.get("text", "")).strip()
        end = round(self.samples * 1000 / self.rate)
        if text:
            self.emit({"type": "final", "text": text[:4000],
                       "speaker": self.speaker_override or self.tracker.identify(value.get("spk"), value.get("spk_frames", 0)),
                       "startedMs": self.start, "endedMs": end})
        elif self.last_partial:
            self.emit({"type": "draft", "text": ""})
        self.start = end
        self.last_partial = ""

    def feed(self, pcm):
        self.samples += len(pcm) // 2
        if self.recognizer.AcceptWaveform(pcm):
            self.result(json.loads(self.recognizer.Result()))
        elif self.samples * 1000 / self.rate - self.start >= 15000:
            # Bound long uninterrupted utterances and speaker-label delay.
            self.result(json.loads(self.recognizer.FinalResult()))
            self.recognizer.Reset()
        else:
            partial = json.loads(self.recognizer.PartialResult()).get("partial", "")[:4000]
            if partial != self.last_partial:
                self.last_partial = partial
                self.emit({"type": "draft", "text": partial})

    def finish(self):
        self.result(json.loads(self.recognizer.FinalResult()))
