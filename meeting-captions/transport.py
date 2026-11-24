"""Text-only HTTPS sender, with ordered retries and a bounded final-phrase queue."""
import json
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from urllib.parse import urlsplit

DEFAULT_SERVER = "https://live-server-app.onrender.com"


class RelayError(Exception):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


def server_origin(value):
    url = urlsplit(value)
    local = url.hostname in ("localhost", "127.0.0.1", "::1")
    if url.username or url.password or url.query or url.fragment or url.path not in ("", "/") or not url.netloc:
        raise ValueError("Use an HTTPS server origin without a path or credentials.")
    if url.scheme != "https" and not (local and url.scheme == "http"):
        raise ValueError("Remote transcript connections require HTTPS.")
    return value.rstrip("/")


def request_json(server, path, body, token=""):
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(server_origin(server) + path, payload, headers, method="POST")
    # Do not forward a private sender token to a redirect target.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=6) as response:
            return json.loads(response.read(32768))
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read(4096)).get("error", "")
        except (ValueError, UnicodeError):
            message = ""
        raise RelayError(message or f"Server returned {error.code}. Deploy the transcript update first.", error.code) from None
    except (OSError, ValueError) as error:
        raise RelayError("Connection interrupted. Final phrases are queued while retrying.") from error


class TextSender:
    def __init__(self, server, token, report=lambda *args: None, send=request_json):
        self.server = server_origin(server)
        self.token = token
        self.report = report
        self.send = send
        self.queue = deque()
        self.condition = threading.Condition()
        self.closed = False
        self.failed = False
        self.sequence = 0
        self.inflight = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def submit(self, packet):
        # Explicit whitelist: numpy/audio/embedding objects cannot enter the relay.
        allowed = {"type", "text", "speaker", "startedMs", "endedMs", "state", "channel"}
        if set(packet) - allowed or packet.get("type") not in ("draft", "final", "status"):
            raise ValueError("Only transcript packets can be sent.")
        with self.condition:
            if self.closed or self.failed:
                raise RelayError("Sender ended. Pair a new session.")
            if packet["type"] in ("draft", "final"):
                channel = packet.get("channel", "meeting")
                self.queue = deque(queued for queued in self.queue if not (
                    queued["type"] == "draft" and queued.get("channel", "meeting") == channel))
            if len(self.queue) >= 100:
                raise RelayError("Connection queue is full. Stop captions and restore your connection.")
            self.queue.append(dict(packet))
            self.condition.notify_all()

    def pending(self):
        with self.condition:
            return len(self.queue) + int(self.inflight)

    def _run(self):
        while True:
            with self.condition:
                while not self.queue and not self.closed:
                    self.condition.wait(timeout=1)
                if self.closed:
                    return
                packet = self.queue.popleft()
                self.inflight = True
                self.sequence += 1
                payload = {"seq": self.sequence, **packet}
            delay = 0.5
            while not self.closed:
                try:
                    result = self.send(self.server, "/api/transcripts/ingest", payload, self.token)
                    if result.get("ackSeq") != self.sequence:
                        raise RelayError("Transcript sequence mismatch. Pair a new session.", 409)
                    self.report("delivery", "Connected · captions delivered")
                    break
                except RelayError as error:
                    self.report("delivery", str(error))
                    if error.status in (400, 401, 403, 404, 409, 413):
                        self.failed = True
                        self.report("fatal", str(error))
                        return
                    with self.condition:
                        self.condition.wait(timeout=delay)
                    delay = min(5, delay * 2)
            with self.condition:
                self.inflight = False

    def close(self):
        with self.condition:
            self.closed = True
            self.token = ""
            self.queue.clear()
            self.condition.notify_all()
