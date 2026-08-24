---
sidebar_position: 10
---

# Troubleshooting

## Models and tasks

- Check Codex sign-in or the local model URL under **Settings → Models**.
- Confirm that the selected model can run on the selected device.
- Restart Codex when prompted after changing a proxy.
- When a local official ChatGPT model keeps reconnecting for 10 seconds or longer because the
  network is unreachable, the conversation identifies the active model and network problem.
  Interruptions that recover within 10 seconds do not show this notice. Select **Configure proxy**
  to open **Settings → Proxy**, save the local proxy, and restart Codex when prompted.
- For task or terminal failures, check whether the device is online, busy, or requires an update.

### A new task is missing from the sidebar

For development diagnostics, run the following command in the Wework Web Inspector console, then reproduce the issue:

```js
localStorage.setItem("wework:debug-runtime", "1");
```

`[Wework] Runtime sidebar state` entries in the frontend log record the executor list result, the merged state, and the task IDs left visible or hidden by sidebar sorting and truncation. If the selected task belongs to the project task list but is outside the visible region, Wework also records `[Wework] Runtime sidebar selected task is hidden`. Run `localStorage.removeItem('wework:debug-runtime')` after diagnosis to disable detailed logging.

## Projects and Git

- Confirm that a local folder exists and is writable.
- Re-select the folder on an online device for a remote project.
- For Git authentication errors, verify the token and repository permissions.
- Check the repository URL, default branch, device network, and proxy for clone failures.

## Reviews and browser

Change review and undo require the original device and per-turn artifact. Resolve later conflicting edits manually.

For browser failures, include `http://` or `https://`, confirm that local servers are listening, and clear browser data only when you are ready to sign in again.

## Cloud connection

Select the cloud status in the sidebar to authorize again. Verify the Backend address with your administrator and confirm that its sign-in page is reachable.

When the network is working but the cloud status occasionally shows unavailable, inspect the Wework frontend log for these entries:

- `[Wework] HTTP ... is still pending after 5000ms.` means that the request has not received a response after five seconds.
- `[Wework] HTTP ... completed slowly ...` records the total duration, HTTP status, and transport.
- `[Wework] HTTP ... failed.` means that no HTTP response was received; inspect the error under `phase: "transport"`.
- `[Wework] HTTP ... returned ...` means that the server returned an HTTP error; inspect the status and error under `phase: "http_error"`.

Every request has a `requestId`. In the desktop client, this value is sent to the Backend as `X-Request-ID`; `backendRequestId` is recorded only when a slow-response or HTTP-error diagnostic event includes the backend's returned request ID. Use these IDs to correlate frontend and Backend logs. The logs do not include Authorization headers, tokens, or request bodies.

## Getting help

Select **Report a problem** in the upper-right corner of the affected task (or in the toolbar for a new conversation). Start with the required problem description. You can paste screenshots or files into the field, or select **Add attachment** to choose files manually. Select **Review problem** to inspect everything that will be submitted or exported.

Optional information behaves as follows:

- **Diagnostics** (on by default): Wework and local runtime logs, plus Wework version and system information. No conversation content and low privacy risk; turn it off when it is not needed.
- **Task context** (off by default): Verbatim conversation history and a full window screenshot. May include business discussions, code, or anything visible on screen; review before including.
- **User attachments**: Only files you pasted or selected yourself; they may contain private information.

If a selected item is unavailable (for example, no task data in a new conversation), it is skipped automatically and noted in the preview.

Expand any entry to inspect its content before continuing. When a feedback service is configured, select **Submit feedback** to send the problem. Otherwise select **Confirm export** to save the bundle in the system Downloads directory. The bundle is generated only on the local computer and is never uploaded automatically. Wework redacts common credentials and the user home path, but free text (such as conversation history) cannot be fully redacted, so review the bundle before sharing.

### Feedback submission failed

When feedback is submitted, the native application log records these events with the report ID:

- `Feedback submission started`: submission began, with the report ID, a redacted endpoint summary, and bundle size.
- `Feedback submission failed`: submission failed, with the stage, elapsed time, and error category; an HTTP status is included when the server responded.
- `Feedback submission completed`: submission succeeded, with the report ID, feedback item ID, duplicate status, and elapsed time.

Search the logs using the report ID shown in the UI, for example `report_id=WF-...`. Endpoint logs retain only the scheme, host, port, and path; they exclude query parameters and URL credentials. The logs also exclude feedback text, task context, and attachment contents.
