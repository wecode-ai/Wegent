---
sidebar_position: 10
---

# Troubleshooting

<!-- ui-source: src/components/common/WorkbenchErrorPage.tsx -->
<!-- ui-source: src/pages/ProcessExplorerPage.tsx -->

## Inspect process resource usage

<a id="process-explorer-controls"></a>

Open the read-only window with the native desktop menu **Help → Developer tools → Process Explorer**.

| Action                | Steps and limits                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Filter and groups     | Search by name, PID or launch details; expand/collapse owner groups to locate windows, executors or plugin processes                  |
| Resources and refresh | Inspect CPU, memory and uptime. Sampling is periodic; Refresh reads again. Totals sum listed Wework processes, not the whole computer |
| Details and copy      | Select a process to inspect/copy launch details; check private directories/arguments before sharing                                   |
| Columns and pinning   | Drag header edges to resize, double-click to reset; toggle always-on-top                                                              |
| Errors/degradation    | Inspect unavailable-information reasons and refresh; partial data does not imply the app stopped                                      |

This window does not terminate processes. Inspection differs from pausing tasks, quitting the app or clearing user data.

## Diagnosing release-package upgrades and rollback

During a release workflow diagnostic replay, `[desktop-e2e-startup]` in `app.log`
records the real process, installed version, selected release and pending transaction.
`[desktop-e2e-relaunch]` records the next executable. Compare these events with
`release-state-result.json` and `activation-diagnostics.log` to distinguish a running
package from the on-disk selection. Diagnostic replays do not produce publishable upgrade proof.
Upgrade acceptance also starts the retained target after rollback has completed, both with
and without a native recovery marker. Both delayed handoffs must return to the source version
and preserve its existing task.

Local verification must isolate both the workbench Home and the native macOS Home;
never move personal application data to satisfy test prerequisites. The test preserves
an explicitly configured `CFFIXED_USER_HOME` alongside its isolated `HOME`.

## Clicking the app icon does not open a window

Clicking the Dock icon again should reveal the existing main or startup recovery window,
including a hidden or minimized window. The main page can appear once its document loads;
renderer health confirmation belongs to upgrade activation and does not gate window visibility.
Failures in log retention, the tray, auxiliary window restoration, CLI installation, or local
model synchronization must not prevent the desktop from opening.

On macOS, when no upgrade or rollback transaction is in progress, ordinary startup runs the
installed package that was opened. After a manual replacement, old release selections, recovery
bridges, or staging directories must not redirect startup to an older application. Damaged upgrade
history produces a warning and allows the installed package to start. Do not delete task data to
work around a startup problem.
Native recovery handoffs and versioned recovery payloads are not ordinary startup. Even after
another process finalized rollback and removed its journal, they must route the selected release
instead of reopening the rejected target.

If the application still cannot open, inspect `wework-main.log`, `runtime-launch.log`, and
`dsh-core-runtime.log` in the desktop log directory. Distinguish runtime failures from background
maintenance warnings. Data migration failures, missing runtime files, and storage permission errors
still need repair; clearing user data must not hide them. Animation, screenshot, and window geometry
errors affect presentation and must not prevent a loaded main window from appearing.

## Conversation export remains on packaging

In the desktop log directory, inspect `dsh-core-runtime.log` for `[wework-conversation-export]` and the export task ID. Finalization logs report the start, completion, or failure of document sync, asset sync, packaging, and destination replacement, including stage duration and asset count. They omit file paths and contents. A stage with only a start event identifies the file operation to investigate; the packaging message alone does not establish that the export has failed.

## Page errors or a blank screen

When a frontend component fails to render, Wework displays “Something went wrong in Wework”.
Select **Refresh page** to reload the interface; unsaved changes may be lost.
The startup error page also offers a refresh action when frontend initialization fails.

If the error persists after refreshing, open the debug panel to view the logs and report
the steps that reproduce the problem. If the renderer process or the entire application
exits and does not recover, reopen Wework.

## Models and tasks

- Check Codex sign-in or the local model URL under **Settings → Models**.
- Confirm that the selected model can run on the selected device.
- Restart Codex when prompted after changing a proxy.
- When a local official ChatGPT model keeps reconnecting for 10 seconds or longer because the
  network is unreachable, the conversation identifies the active model and network problem.
  Interruptions that recover within 10 seconds do not show this notice. Select **Configure proxy**
  to open **Settings → Proxy**, save the local proxy, and restart Codex when prompted.
- For task or terminal failures, check whether the device is online, busy, or requires an update.

### Model at capacity

`Selected model is at capacity. Please try a different model.` indicates model
service overload, not a task-code failure. For structured overload errors in
direct Codex tasks, Wework keeps the original conversation and model, waits 5,
10, 20, 40, and 60 seconds, and automatically continues up to five times. You can
stop the task during recovery. Recovery does not replay the original task or add
a user message.

A newly created Goal that immediately encounters overload also shows its blocked
state, then returns to active when recovery starts.

If overload stops an active Goal, recovery resumes that Goal with its objective,
budget, and accumulated usage intact, including automatic continuation after the
current turn. Pausing, deleting, or editing the Goal during backoff cancels its
pending recovery; Wework does not recreate the Goal or overwrite your changes.

If recovery is exhausted, retry later or select **Switch model and retry**.
Authentication, quota, and context-window errors are not automatically recovered
under the overload policy.

### Background terminal history

Background terminals retain collected output after restoring a conversation. Use `Shift + PageUp` and `Shift + PageDown` to navigate history. Screen-reader row positions and character alignment update with the output; live output and history navigation should not block other interface actions.

### Tools unavailable after resuming a conversation

If MCP tools failed to start or their connection was interrupted, sending another message in the same conversation checks their actual connection status and attempts recovery while preserving the conversation and healthy tool connections. Restarting the app is unnecessary. Each new execution reconciles at most once, concurrent continuations share recovery, and an execution never loops on a persistent failure. A later continuation can still recover a service that becomes available afterward. Tools requiring login or renewed authorization still require that authorization. Connection recovery does not replay earlier tool operations.

The `codex MCP startup status` log records the process generation, conversation, server, startup status, and redacted error. `codex MCP startup recovery` records the servers that triggered recovery. Preserve these records if the problem persists.

### Unable to connect to the model service

When the local model proxy cannot send a request to the model service, the conversation shows **Unable to connect to the model service** and includes the complete failed endpoint directly in the error card. `Failed to send a request` means that the client did not receive a usable HTTP response. Check the current network, VPN, proxy, and DNS settings. For an internal endpoint, also confirm that the device is connected to the corporate network or VPN.

Expand **Error details** to inspect the original service error. Only a 502 response that contains connection-failure details is reported as a model service connection error; a regular 502 response from a service that was reached is still reported as a request timeout.

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

<a id="getting-help"></a>

## Getting help

Select **Report a problem** in the upper-right corner of any Wework desktop page, including tasks, new conversations, Plugins, My Stand-in, Scheduled and Settings. Start with the required problem description. You can paste screenshots or files into the field, or select **Add attachment** to choose files manually. Select **Review problem** to inspect everything that will be submitted or exported.

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
