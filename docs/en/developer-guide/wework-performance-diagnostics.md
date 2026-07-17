---
sidebar_position: 33
---

# Performance Diagnostics

Wework includes an opt-in frontend performance diagnostics switch for investigating release builds that become slow after running for a while. The diagnostics code only runs after it is explicitly enabled; when disabled, the app does not install React Profiler and does not collect interval samples.

## Debugging Multiple Instances

When `pnpm --filter wework dev:mac` starts a debug app, each Wework process uses its own local executor runtime directory and IPC address file. Multiple debug windows can run concurrently without connecting to the same executor instance.

Development instances share one Cargo target directory by default so executor source changes can reuse incremental build artifacts. Set `WEGENT_DISABLE_SHARED_CARGO_TARGET=1` to use the project's default target directory when investigating shared build-cache issues.

## Diagnosing Startup Time

The desktop startup screen waits only for the local executor to report ready; debug builds do not delay the workbench to finish an animation cycle. On a cold start, Tauri cleans up the previous executor and IPC address file, then starts a new sidecar immediately. It attempts to attach to an existing sidecar only when reconnecting after a live connection is lost.

When the startup screen remains visible, align `Frontend logging initialized` in the frontend log with `app IPC listening` in the executor log. The interval primarily measures local executor cold startup. Later entries such as `runtime work list finished` identify workbench data-loading time. Do not mistake a background cloud synchronization timeout for the local startup gate.

## Enabling Diagnostics

Press the hidden shortcut in the Wework window:

```text
macOS: Cmd + Option + Shift + P
Windows/Linux: Ctrl + Alt + Shift + P
```

The shortcut opens the **Developer Commands** menu. Select **Enable Performance Diagnostics** to write the `wework:perf-debug` flag in `localStorage` and reload the app; open the menu again and select **Disable Performance Diagnostics** to disable diagnostics and reload.

Development builds can also toggle diagnostics through a URL parameter:

```text
?weworkPerf=1  # enable
?weworkPerf=0  # disable
```

For local reproduction, set `VITE_WEWORK_PERF_DEBUG=1` to enable diagnostics by default.

## Debug Panel

The **Debug Panel** command in the Developer Commands menu helps diagnose the currently active Wework runtime task. It shows:

- The active runtime task address, whether the task is known, the raw `running` value, task status, and pane-derived running state.
- The current pane send phase, message counts, queued messages, transcript loading state, subagent state, and goal state.
- A field and expected UI style comparison between transcript-loaded messages and the current streaming output.
- Recent `console.debug` logs.

The Debug Panel can be expanded, collapsed, refreshed, copied as a snapshot, and cleared. When collapsed, it leaves only a small status bar in the lower-right corner so it does not block the main UI.

### Runtime Memory Snapshots

Debug Panel snapshots include a lightweight memory summary for the active runtime pane to help investigate WebView or executor memory spikes:

- Message count, role distribution, status distribution, and content-length totals.
- Processing block count, block type distribution, and tool-output length totals.
- Queued messages, guidance messages, code-comment context count, and transcript range state.
- The raw `running` value from the runtime work list and the running state derived by the pane.

Snapshots only include summaries. They do not copy full command output, raw Codex events, or full transcript content into the Debug Panel. When raw payloads are needed, inspect executor logs or Web Inspector samples instead of moving large text through the frontend snapshot path.

## Runtime Transcript and List Payloads

To reduce frontend and executor memory pressure, runtime task lists, runtime handle summaries, and transcript responses keep only fields required by the UI. Large raw payloads such as command output, streaming deltas, cached messages, and raw request/response bodies are not sent to the frontend through runtime work list payloads.

Conversation rendering still uses `WorkbenchMessage` values produced from transcript loads and message actions. Task lists and status polling are for status, titles, running state, and workspace metadata. When investigating slow list refreshes or memory growth while switching tasks, first check whether raw messages or command output have been reintroduced into the runtime list, handle, or transcript metadata path.

## Local Codex Streaming Logs

The local executor keeps Codex delta details enabled by default so developers can diagnose streaming order, phase classification, and final-content overwrite issues. By default, it records raw Codex delta events and run-state classification summaries.

The **Enable Stream Logs** / **Disable Stream Logs** command in the Developer Commands menu toggles both frontend local chat stream logs and Codex executor stream logs. Prefer this command during live investigation; it keeps frontend `console.debug` stream subscription/event logs and executor Codex stream details under the same switch.

To avoid excessive logs in debug builds during long responses or high-frequency token output, runtime work cache/emit mapping logs are disabled by default. Those logs add extra records for the cache path and UI event dispatch path of the same delta, and are only needed when diagnosing local runtime work routing.

Available environment variables:

```text
WEGENT_CODEX_STREAM_DEBUG=0          # disable raw Codex delta / classification details
WEGENT_CODEX_STREAM_DEBUG=1          # enable raw Codex delta / classification details (default)
WEGENT_CODEX_STREAM_MAPPING_DEBUG=1  # enable runtime work cache/emit mapping details
```

## Streaming Message Rendering

Wework separates high-frequency executor text deltas from the visible Markdown cadence. Message state still receives and retains the complete content in real time, while `AssistantMarkdown` uses a lightweight buffer to advance visible text on browser frames. It catches up adaptively when the backlog grows, then retains a small character reserve and drains it slowly near the tail to smooth executor bursts and short delivery gaps. The renderer immediately aligns with complete content when streaming ends, content is replaced, or an update is not append-only, preserving final-message correctness.

Streaming messages skip full Pretext height measurement and use a stable offscreen intrinsic height. Completed messages are measured precisely and cached. Height lookup first uses the message object and width, avoiding repeated full-text hashes for unchanged historical messages during every stream update. Stable props and memo boundaries also keep the composer, workspace actions, right workspace, and bottom terminal from rerendering for every text delta.

While the bottom Terminal panel is being resized, height updates are coalesced to browser animation frames and height transitions are disabled. This prevents high-frequency pointer events from causing excessive React updates and Terminal layout work. Releasing the pointer must commit the final height and restore the transitions used when opening or closing the panel.

Distinguish these cases when investigating streaming stalls:

- The frame rate is stable but output alternates between fast and slow: inspect stream `message` event intervals. Executor batching or network/IPC delivery gaps are usually responsible.
- Long frames, dense style recalculation, or Markdown parsing appear: check whether code bypasses the text buffer, destabilizes Streamdown component references, or reintroduces per-character DOM animation.
- GC time is unexpectedly high: verify whether Web Inspector has **Heap Allocations** enabled. That instrument can significantly amplify GC during longer recordings and should be disabled when diagnosing interaction smoothness alone.

Streaming-buffer unit tests live in `wework/src/components/chat/useBufferedStreamingText.test.ts`. Changes to the reserve or advance rate must continue to cover Unicode boundaries, non-append updates, and immediate alignment when streaming ends.

## Collected Data

When enabled, the diagnostics module records:

- Browser long tasks.
- Event loop lag above 120ms.
- A 5-second sample of memory, DOM node count, resource count, and visibility state.
- React root commit durations above 24ms.
- Manual mark events.

The latest 300 events are kept in memory and exposed through `window.__WEWORK_PERF__`. Diagnostics data is not uploaded to the server.

## Capturing Evidence

Normal release builds do not compile Tauri Web Inspector support. To investigate a release build, first create a diagnostics build:

```bash
pnpm --filter wework build:mac:devtools
```

To create an updater-compatible diagnostics build through the macOS release script, use:

```bash
bash wework/scripts/release-mac-app.sh --target local --devtools
```

You can also set `WEWORK_RELEASE_DEVTOOLS=1`. After launching the diagnostics build, press the hidden shortcut to open **Developer Commands**, then select **Open Web Inspector**. To open it automatically at startup, use:

```bash
WEWORK_WEBVIEW_DEVTOOLS=1 /path/to/WeWork.app/Contents/MacOS/WeWork
```

After Web Inspector opens, run this when the app becomes slow:

```js
window.__WEWORK_PERF__.snapshot();
```

The snapshot includes the current URL, page visibility, DOM node count, memory snapshot, navigation timing, resource count, recent events, and Wework process-group data. macOS reparents WebKit XPC processes to PID 1; diagnostics use LaunchServices to associate the current Wework instance with its Web Content, GPU, and Networking processes.

Each process group reports both `rss_kib` and `physical_footprint_kib`. RSS includes shared mappings and reclaimable resident pages and is commonly much larger than actual memory pressure. Prefer `physical_footprint_kib` when investigating leaks or system resource usage, and treat RSS as a secondary residency metric. When comparing multiple snapshots, focus on:

- Whether `memory.usedJSHeapSize` keeps growing.
- Whether `processMemory.groups[].physical_footprint_kib` keeps growing after a task completes and cools down.
- Whether growth belongs to `webkit-webcontent`, `codex-app-server`, `executor`, or `main`.
- Whether `domNodeCount` keeps growing.
- Dense `longtask` or `event-loop-lag` events.
- Repeated `slow-react-commit` events.

Manual marks can also be added:

```js
window.__WEWORK_PERF__.mark("before-open-task", { taskId: "..." });
```

## Disabling Diagnostics

Press the hidden shortcut to open the Developer Commands menu, then select **Disable Performance Diagnostics** to disable diagnostics and reload. The console can also disable it:

```js
localStorage.removeItem("wework:perf-debug");
location.reload();
```

After diagnostics are disabled, `window.__WEWORK_PERF__` is not installed and React Profiler no longer wraps the app root.
