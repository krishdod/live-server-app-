import json
import threading
import time
import unittest

from speech import CaptionStream, SpeakerTracker
from transport import RelayError, TextSender, server_origin


def vector(index):
    return [1.0 if i == index else 0.0 for i in range(128)]


class SenderTests(unittest.TestCase):
    def test_speaker_clusters_persist_without_sending_embeddings(self):
        tracker = SpeakerTracker()
        self.assertEqual(tracker.identify(vector(0), 150), "speaker-1")
        self.assertEqual(tracker.identify(vector(1), 150), "speaker-2")
        self.assertEqual(tracker.identify(vector(0), 200), "speaker-1")
        self.assertEqual(tracker.identify(vector(0), 20), "unknown")
        self.assertEqual(tracker.identify([float("nan")] * 128, 150), "unknown")

    def test_ambiguous_and_extra_speakers_remain_unknown(self):
        tracker = SpeakerTracker(max_speakers=2)
        tracker.identify(vector(0), 150)
        tracker.identify(vector(1), 150)
        self.assertEqual(tracker.identify([a + b for a, b in zip(vector(0), vector(1))], 150), "unknown")
        self.assertEqual(tracker.identify(vector(2), 150), "unknown")

    def test_final_phrase_contains_only_text_label_and_time(self):
        class Recognizer:
            def AcceptWaveform(self, pcm): return True
            def Result(self): return json.dumps({"text": "hello there", "spk": vector(0), "spk_frames": 150})
        packets = []
        stream = CaptionStream(Recognizer(), packets.append, sample_rate=16000)
        stream.feed(b"\0" * 32000)
        self.assertEqual(packets, [{"type": "final", "text": "hello there", "speaker": "speaker-1", "startedMs": 0, "endedMs": 1000}])

    def test_unknown_short_phrase_is_kept(self):
        class Recognizer:
            def FinalResult(self): return '{"text":"yes","spk_frames":10}'
        packets = []
        CaptionStream(Recognizer(), packets.append).finish()
        self.assertEqual(packets[0]["speaker"], "unknown")
        self.assertEqual(packets[0]["text"], "yes")

    def test_optional_microphone_uses_its_own_known_label(self):
        class Recognizer:
            def FinalResult(self): return '{"text":"my own voice"}'
        packets = []
        CaptionStream(Recognizer(), packets.append, speaker_override="local").finish()
        self.assertEqual(packets[0]["speaker"], "local")

    def test_remote_plain_http_and_credential_urls_rejected(self):
        for url in ("http://example.com", "https://key@example.com", "https://example.com/path", "https://example.com/#secret"):
            with self.assertRaises(ValueError): server_origin(url)
        self.assertEqual(server_origin("http://127.0.0.1:8765"), "http://127.0.0.1:8765")

    def test_retry_reuses_sequence_and_final_is_delivered_once(self):
        calls, done = [], threading.Event()
        def send(server, path, packet, token):
            calls.append(dict(packet))
            if len(calls) == 1: raise RelayError("temporary failure")
            done.set()
            return {"ackSeq": packet["seq"]}
        sender = TextSender("https://example.com", "test", send=send)
        try:
            sender.submit({"type": "final", "text": "question", "speaker": "unknown", "startedMs": 0, "endedMs": 1000})
            self.assertTrue(done.wait(3))
            self.assertEqual(calls[0], calls[1])
        finally: sender.close()

    def test_audio_and_embeddings_never_enter_transport(self):
        sender = TextSender("https://example.com", "test", send=lambda *args: {})
        try:
            for packet in ({"type": "audio", "audio": b"abc"}, {"type": "final", "text": "hi", "spk": vector(0)}):
                with self.assertRaises(ValueError): sender.submit(packet)
        finally: sender.close()

    def test_revocation_stops_retrying(self):
        ended = threading.Event()
        def send(*args): raise RelayError("revoked", 403)
        sender = TextSender("https://example.com", "test", send=send, report=lambda kind, text: ended.set() if kind == "fatal" else None)
        try:
            sender.submit({"type": "status", "state": "listening"})
            self.assertTrue(ended.wait(2))
            self.assertTrue(sender.failed)
        finally: sender.close()


if __name__ == "__main__":
    unittest.main()
