# Approve who can view your live answers

This update adds a request-and-approval screen for viewers. Your Caption Copier,
ChatGPT page, extension publishing key, and owner editing controls keep their
existing jobs. Access is enforced by the server, so copying an old viewer link
or using a browser instead of the EXE does not skip approval.

## For the person using your app

1. Open the new Windows viewer and choose **Open**. Its default address is
   `https://live-server-app.onrender.com/access`.
2. Enter a name and choose **Request access**.
3. Send the displayed request code to the owner through your usual conversation.
4. Keep the app open. Once the owner approves, the live viewer opens automatically.
5. Use the existing window controls as before. The request and login screens stay
   clickable; click-through applies only after access is granted.

The code identifies a request; it is not a password. Do not approve a request
based only on the name, which anyone can type. Confirm the code with the person
you intend to admit.

## For you, the owner

Open your normal editor link and choose **Viewer access**, or open
`https://live-server-app.onrender.com/access-admin` in your browser. The dashboard
uses your existing editor access key and, if configured, your existing app
password. Never give users your editor key, app password, or extension key.

Match the user's code, then choose **1 hour**, **24 hours**, or **Reject**.
Use **Revoke** to disconnect an approved session. New viewer requests never
grant editing or publishing permissions. All approved viewers in this server
see this server's single shared workspace; this is not a separate private
workspace for each user.

Short disconnects and page reloads can reconnect during the approval period.
Closing the desktop app ends its temporary browser session. Access requests and
approvals are held in server memory: a restart, redeploy, or free-host shutdown
requires fresh approval. No database, SMS service, paid authentication service,
or email delivery is needed for these approvals.

## Activate on the hosted server

Building an EXE does not deploy server changes. Deploy the accompanying server
update before distributing the new EXE. Keep your existing environment values:

- `EDIT_KEY`: required when viewer approval is enabled; keep this owner-only.
- `STREAM_KEY`: unchanged; must still match the Chrome extension.
- Use different values for `EDIT_KEY`, `VIEW_KEY`, and `STREAM_KEY`. A viewer or
  publishing key must never also act as the owner's key.
- `APP_PASSWORD`: keep your existing password if you already use the login gate.
- `APP_ORIGIN`: the exact public website origin, for example
  `https://live-workspace.onrender.com` (no path or query).
- `VIEWER_APPROVAL_REQUIRED=true`: enabled by default in this update.

`VIEW_KEY` is retained for compatibility when approval is explicitly disabled.
While approval is enabled, that key alone does not grant access. Owner access
through `EDIT_KEY` still works, subject to the existing password gate.

The server must run as a single instance for this no-database version. Do not
enable multiple replicas; approval memory would not be shared between them.
If the origin is configured incorrectly, request/approval actions are denied
instead of accepting requests from an unknown website.

For local development, set a unique `EDIT_KEY` before running `npm start` in
`server/`. Set `STREAM_KEY` to match your local test extension. Open
`http://localhost:8765/?role=edit&key=YOUR_LOCAL_EDITOR_KEY` as the owner and
`http://localhost:8765/access` in a separate browser session as the viewer.
For LAN or tunnel testing, also set `APP_ORIGIN` to the exact origin the viewer
will use. Production should use HTTPS.

After deployment, test with a separate browser session: request access, approve
the matching code, confirm a new answer arrives with its formatting, then revoke
access and confirm the viewer clears and disconnects. Use a test answer only
when you intend it to appear in the shared workspace.

## Cost and recovery

The feature introduces no paid services. Hosting remains subject to the free
provider's usage limits and startup delays. Keep the free plan and avoid adding
paid resources. Render's free limits are documented at
<https://render.com/docs/free>.

If you need to temporarily restore the previous link-based viewer access,
explicitly set `VIEWER_APPROVAL_REQUIRED=false` and restart the server. That
allows access with the old viewer key again; it disables owner approval.
The previous `desktop-viewer/dist-v4` build is preserved locally.

The Windows build remains a capture-protected viewer, with the same limits as
before. Approval controls who receives answers; it does not change which screen
sharing tools honor window capture exclusion.

## Checks

Run `npm ci` and `npm test` in `server/` for approval, relay, UI, and formatting
regressions. Run `npm ci` and `npm test` in `desktop-viewer/` for desktop policy
and window control checks. On Windows, `npm run test:smoke` and
`npm run test:approval-smoke` in `desktop-viewer/` exercise the native renderer
against temporary localhost servers. They use fake credentials and never
contact the hosted workspace.
