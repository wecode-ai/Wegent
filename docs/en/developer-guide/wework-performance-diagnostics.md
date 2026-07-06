---
sidebar_position: 33
---

# Performance Diagnostics

Wework includes an opt-in frontend performance diagnostics switch for investigating release builds that become slow after running for a while. The diagnostics code only runs after it is explicitly enabled; when disabled, the app does not install React Profiler and does not collect interval samples.

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

## Local Codex Streaming Logs

The local executor keeps Codex delta details enabled by default so developers can diagnose streaming order, phase classification, and final-content overwrite issues. By default, it records raw Codex delta events and run-state classification summaries.

To avoid excessive logs in debug builds during long responses or high-frequency token output, runtime work cache/emit mapping logs are disabled by default. Those logs add extra records for the cache path and UI event dispatch path of the same delta, and are only needed when diagnosing local runtime work routing.

Available environment variables:

```text
WEGENT_CODEX_STREAM_DEBUG=0          # disable raw Codex delta / classification details
WEGENT_CODEX_STREAM_DEBUG=1          # enable raw Codex delta / classification details (default)
WEGENT_CODEX_STREAM_MAPPING_DEBUG=1  # enable runtime work cache/emit mapping details
```

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

The snapshot includes the current URL, page visibility, DOM node count, memory snapshot, navigation timing, resource count, and recent events. When comparing multiple snapshots, focus on:

- Whether `memory.usedJSHeapSize` keeps growing.
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
