# Meeting Caption Sender — preview

Run this companion app on the computer where the meeting happens. The helper
receives English text with estimated speaker labels. Audio and voice embeddings
stay on the meeting computer. Internet is still needed to deliver text and use
ChatGPT. Python, Node and both speech models are included in recipient builds.

## Deploy the server first

Deploy the server changes from this branch through your normal Render deployment.
Keep your existing `EDIT_KEY`, `STREAM_KEY`, `APP_ORIGIN` and optional workspace
password. No speech-service key is needed. This feature will not work on the
currently deployed version until the new server files are deployed. A 404 on
`/transcripts` means the update is not live yet.

## On the helper's computer

1. Open <https://live-server-app.onrender.com/transcripts> after deployment.
2. Sign in with the same owner key and optional password as Viewer access.
   Never give the sender your owner key or publishing key.
3. Click **New session**, then **Copy code**. Give that one-use code to the
   meeting participant. It expires in 10 minutes.
4. Keep the page open. Draft text appears first, followed by finalized phrases
   with Speaker 1 / Speaker 2 labels. Short phrases may be **Unknown**.
5. Select a label under **Speakers**, enter a name and click **Save name**.
   Correct individual phrases using their speaker menus.
6. Update the helper's Live Workspace extension to **5.4.2 or later**, reload it
   at `chrome://extensions`, and refresh this transcript page. Turn on
   **Auto-copy** once. The newest finished captions, including speaker labels,
   will copy automatically while you use ChatGPT. Paste with **Ctrl+V** on Windows
   or **Cmd+V** on Mac, review and send. New phrases replace the clipboard;
   drafts and edits to old speaker labels do not trigger copying. Auto-copy
   resets when you switch sessions, sign out or close the page. Turn it off to
   keep your clipboard unchanged. Manual **Copy** buttons remain available.
   The extension needs clipboard-writing permission; it does not read your
   existing clipboard. Nothing is pasted or submitted to ChatGPT automatically.
   ChatGPT answers still use the separate answer stream.
7. Click **End & erase** when finished. This removes the transcript from the
   server and invalidates the sender. Signing out only signs out this tab.

## On the meeting computer — Windows

1. Open `MeetingCaptionSender-0.1.0-preview.exe`. The old Caption Copier is not
   needed for this mode.
2. Enter your name and the helper's pairing code. Click **Pair with helper**.
3. Choose the speaker output used by the meeting, such as your headphones.
   The system default is selected first. Capture includes other apps playing
   on this same output, so select the intended device.
4. Optionally enable **Include my microphone (system default)** for your own
   voice. It is labeled **Meeting host**, separately from remote voices. Keep
   the meeting app microphone set to your normal physical microphone. Use
   headphones so it does not pick up the remote voices a second time.
5. Click **Start captions**. Audio capture begins only after this action.
6. Click **Stop captions** to stop. Keep the window open until queued phrases
   finish sending, then close it.

## On the meeting computer — Mac

Use the Apple Silicon app for M-series Macs, or the Intel app for Intel Macs.
The app is ad-hoc signed, without Apple Developer ID/notarization; use the normal
macOS app-opening approval when prompted. It cannot bypass this approval.

This first version needs [BlackHole 2ch](https://existential.audio/blackhole/):

1. Install BlackHole 2ch. Open **Audio MIDI Setup** and create a **Multi-Output
   Device** containing your headphones/speakers and BlackHole 2ch.
2. Use matching sample rates and drift correction as described in
   [BlackHole's Multi-Output guide](https://github.com/ExistentialAudio/BlackHole/wiki/Multi-Output-Device).
3. Choose this Multi-Output Device as the meeting speaker/output. If the meeting
   app has no output selector, choose it as the system output.
4. Keep the meeting microphone set to your physical microphone, not BlackHole.
5. Open the sender, pair with the helper's code, and select **BlackHole** as the
   audio source. Allow microphone access when macOS asks: virtual CoreAudio
   inputs also require input permission.
6. Enable the optional microphone only if you want your own voice included.
   The system-default input must be a physical microphone, not BlackHole.
7. Click **Start captions**. Restore your normal output after the meeting.

## Limits of this preview

- Local English recognition can mishear accents, technical words and distorted
  audio. It cannot recover words lost before audio reaches the source computer.
- Labels are estimates for completed phrases, up to eight remote speakers plus
  the optional local microphone. This is not word-level diarization. Speech
  changes without pauses and overlapping voices can be combined or mislabeled.
  Correct them on the helper page.
- Latency depends on hardware and connection. Drafts arrive before speaker
  estimates. Long continuous speech is finalized at most every 15 seconds.
  Including the microphone adds processing. Capture stops with an error if the
  computer falls about two seconds behind, rather than building an audio backlog.
- Text retries in order after connection failures. The queue holds up to 100
  packets in memory; a full queue stops capture. Closing the app loses unsent
  text. No audio recording is written to disk.
- One sender pairs to each session. Sessions expire after two hours; the server
  retains up to 300 phrases / 250,000 characters per session in memory. Ending
  erases a session; server restart loses all sessions. HTTPS protects transit;
  the relay operator can read transcript text.
- Windows startup, bundled recognition and the relay were checked here with a
  public sample. Real meetings, Mac audio routing and simultaneous voices still
  need device testing before wider release.

## Run or build from source

Use 64-bit Python 3.11 or 3.12 with Tkinter. In `meeting-captions`, create and
activate a virtual environment, then run:

```text
python -m pip install -r requirements.txt
python models.py
python sender.py
```

Model setup downloads only the official English and speaker models, verifies
pinned SHA-256 checksums and installs them locally. No audio is sent. To build,
install `pyinstaller==6.22.3` and run `python build.py`. Windows produces one EXE;
Mac produces an app for the build machine's architecture. The GitHub workflow
builds and checks Windows, Intel Mac and Apple Silicon Mac separately.

For local testing, `--server http://127.0.0.1:PORT` is available. Remote connections
require HTTPS with certificate verification. Sender tokens stay in memory and
cannot read or edit the answer workspace.

Sources: [Vosk models](https://alphacephei.com/vosk/models),
[Vosk speaker example](https://github.com/alphacep/vosk-api/blob/master/python/example/test_speaker.py),
[SoundCard](https://soundcard.readthedocs.io/en/latest/).
