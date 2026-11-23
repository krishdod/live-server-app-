"""Local integration fixture: recognize a public sample and relay its text."""
import argparse
import json
import os
import time
from smoke import recognize_fixture
from transport import request_json, TextSender

parser = argparse.ArgumentParser()
parser.add_argument("--server", required=True)
parser.add_argument("--models", required=True)
parser.add_argument("--wav", required=True)
options = parser.parse_args()
paired = request_json(options.server, "/api/transcripts/pair", {"code": os.environ["LW_TEST_PAIR_CODE"], "name": "Public audio fixture"})
result = recognize_fixture(options.models, options.wav)
sender = TextSender(options.server, paired["token"])
try:
    for packet in result["packets"]:
        sender.submit(packet)
    sender.submit({"type":"status", "state":"stopped"})
    deadline = time.monotonic() + 10
    while sender.pending() and not sender.failed and time.monotonic() < deadline:
        time.sleep(0.05)
    if sender.pending() or sender.failed:
        raise RuntimeError("Public fixture did not reach the test relay.")
    print(json.dumps({"passed":True,"phrases":len(result["packets"])}))
finally:
    sender.close()
