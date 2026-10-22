# Caption Copier for ChatGPT web

Close the old Caption Copier before opening `dist/Caption Copier Web Fix.exe`.
Open your ChatGPT conversation in Chrome, select that Chrome window with
**Select ChatGPT**, and try **Send to ChatGPT** with a short test caption.

The new app only pastes into an identified, focused ChatGPT message box. It
does not paste into a generic Chrome field or use an address-bar fallback.
It leaves existing drafts intact and submits once. If it cannot verify the
message box or submission, it shows **Not sent**; check the draft in ChatGPT
before retrying.

The original app and source under `C:\Users\admin\caption` have not been replaced.
The window title identifies this build as **Caption Copier — Web Fix 5.4**.
It handles Chrome's empty “Ask ChatGPT” placeholder and clicks the identified
message box if Chrome ignores the initial focus request. It still verifies
focus before sending any keys and reports the specific reason if blocked.

The corrected source is `simple_caption_tool.py` in this folder. Its ten
focused send tests pass. The packaged executable passed its non-interactive
runtime self-test; actual sending in your signed-in Chrome tab remains to be
checked.

## Answer formatting

Reload Live Workspace from `C:\Users\admin\Downloads\live-stream-main` in
`chrome://extensions`, then refresh ChatGPT. Extension version 5.3 preserves
Markdown during capture.

The local server now renders headings, emphasis, lists, tables, and unfinished
streaming code blocks. These changes include `server/viewer.html`,
`server/markdown.js`, the scripts and licenses in `server/vendor`, and the
static script routes in `server/server.js`.

The hosted Render server has not been updated. Its newer authentication code
must be preserved when applying these changes; do not overwrite it with this
older local server file.
