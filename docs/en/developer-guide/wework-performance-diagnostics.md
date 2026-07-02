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

The shortcut toggles the `wework:perf-debug` flag in `localStorage` and reloads the app. Press the same shortcut again to disable diagnostics and reload.

Development builds can also toggle diagnostics through a URL parameter:

```text
?weworkPerf=1  # enable
?weworkPerf=0  # disable
```

For local reproduction, set `VITE_WEWORK_PERF_DEBUG=1` to enable diagnostics by default.

## Collected Data

When enabled, the diagnostics module records:

- Browser long tasks.
- Event loop lag above 120ms.
- A 5-second sample of memory, DOM node count, resource count, and visibility state.
- React root commit durations above 24ms.
- Manual mark events.

The latest 300 events are kept in memory and exposed through `window.__WEWORK_PERF__`. Diagnostics data is not uploaded to the server.

## Capturing Evidence

If Web Inspector is available in a debug or release build, run this after the app becomes slow:

```js
window.__WEWORK_PERF__.snapshot()
```

The snapshot includes the current URL, page visibility, DOM node count, memory snapshot, navigation timing, resource count, and recent events. When comparing multiple snapshots, focus on:

- Whether `memory.usedJSHeapSize` keeps growing.
- Whether `domNodeCount` keeps growing.
- Dense `longtask` or `event-loop-lag` events.
- Repeated `slow-react-commit` events.

Manual marks can also be added:

```js
window.__WEWORK_PERF__.mark('before-open-task', { taskId: '...' })
```

## Disabling Diagnostics

Press the hidden shortcut again to disable diagnostics and reload. The console can also disable it:

```js
localStorage.removeItem('wework:perf-debug')
location.reload()
```

After diagnostics are disabled, `window.__WEWORK_PERF__` is not installed and React Profiler no longer wraps the app root.
