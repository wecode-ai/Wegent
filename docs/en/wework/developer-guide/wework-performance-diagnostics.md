---
sidebar_position: 33
---

# Performance Diagnostics

Wework includes an opt-in frontend performance diagnostics switch for investigating release builds that become slow after running for a while. The diagnostics code only runs after it is explicitly enabled; when disabled, the app does not install React Profiler and does not collect interval samples.

## Debugging Multiple Instances

For everyday development, `pnpm --filter wework dev:mac` uses the release app's Executor Home by default, so projects and tasks are shared with the locally installed release Wework. Each Wework process still communicates with its own executor child through stdio, preventing endpoint collisions or attachment to another executor. Use `pnpm --filter wework dev:mac -- --executor-isolation` when projects and tasks must be isolated temporarily.

`ai:verify` and desktop E2E do not use that shared default. They explicitly create a temporary Executor Home, projects directory, device ID, and unique Electron app-data namespace, isolating tasks, projects, application data, and the single-instance lock from release and other verification sessions.

Development instances share one Cargo target directory by default so executor source changes can reuse incremental build artifacts. Set `WEGENT_DISABLE_SHARED_CARGO_TARGET=1` to use the project's default target directory when investigating shared build-cache issues.

## Diagnosing Startup Time

The desktop startup screen waits only for the local executor to report ready through stdout; debug builds do not delay the workbench to finish an animation cycle. On a cold start, Electron starts a new sidecar directly and does not discover or attach to an existing executor.

When the startup screen remains visible, align `Frontend logging initialized` in the frontend log with `app IPC stdio ready` in the executor log. The interval primarily measures local executor cold startup. Later entries such as `runtime work list finished` identify workbench data-loading time. Do not mistake a background cloud synchronization timeout for the local startup gate.

### First-Paint Gates and Idle Work

The workbench first paint depends only on the local executor being available. It does not wait for the Codex app-server, plugin marketplace synchronization, or scans of directories eligible for cleanup. Features that need Codex start it on demand; maintenance such as plugin auto-updates, bundled marketplace preparation, and temporary-image cleanup runs through one renderer idle-task scheduler.

An idle task starts only when all of these conditions hold:

- The workbench first paint is available.
- There has been no recent keyboard, pointer, touch, or wheel input, and the renderer receives a sufficiently large idle-callback slice.
- CPU utilization, available memory, and system idle time sampled by the Electron main process remain below the configured pressure limits.

Pending requests with the same task ID are coalesced, and idle tasks start serially. New user input postpones work that has not started, and a failed pressure probe prevents execution. The scheduler only decides when work may begin; a task must not perform synchronous heavy work on the renderer main thread. File scanning and copying belongs in the Executor blocking pool, directory cleanup uses asynchronous I/O in the Electron main process, and network synchronization remains asynchronous.

After first paint, the bundled plugin marketplace computes a deterministic content SHA-256. When `.wework-content-sha256` in the destination matches the current content, Wework skips the copy. Changed content is replaced through a staging directory, and the hash participates in the Codex local-marketplace registration key. Bundled plugins therefore refresh after a Wework upgrade without recopied content on every launch of the same version.

## Diagnosing Runtime Task Creation

The frontend writes key task-creation stages to the persisted log with the `[Wework] Runtime task create diagnostic` prefix. This does not require Performance Diagnostics to be enabled. Records contain only the stage, task/device identifiers, model identifiers, elapsed time, and result; they do not contain message content, credentials, or model connection configuration.

When an optimistic task is visible but the executor never receives `runtime.tasks.create`, find the last stage logged in this sequence:

1. `workbench-model-prepare-*`: the workbench starts and completes its initial model preparation.
2. `workbench-runtime-create-dispatched`: the workbench begins calling the runtime creation API.
3. `hybrid-local-device-discovery-*` and `hybrid-route-resolved`: the hybrid service completes device discovery and selects the local or cloud route.
4. `hybrid-create-forwarded`: the creation request is forwarded to the selected runtime API.
5. `local-device-resolved`, `local-primary-model-prepared`, `local-supervisor-model-prepared`, and `local-payload-built`: the local/remote Executor IPC client completes device resolution, model preparation, and payload construction.
6. `local-rpc-dispatched` and `local-rpc-resolved`: `runtime.tasks.create` is sent and returns.
7. `hybrid-create-resolved` or `hybrid-create-failed`: the hybrid service observes the final result.

A missing next stage usually means the call stalled between the two records. Correlate the same `taskId` across the frontend log, cloud WebSocket RPC log, and executor log to identify whether model synchronization, device discovery, payload construction, IPC dispatch, or the executor response is blocked.

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

Snapshots only include summaries. They do not copy full command output, raw Codex events, or full transcript content into the Debug Panel. When raw payloads are needed, inspect executor logs or DevTools samples instead of moving large text through the frontend snapshot path.

## Runtime Transcript and List Payloads

To reduce frontend and executor memory pressure, runtime task lists, runtime handle summaries, and transcript responses keep only fields required by the UI. Large raw payloads such as command output, streaming deltas, cached messages, and raw request/response bodies are not sent to the frontend through runtime work list payloads.

Conversation rendering still uses `WorkbenchMessage` values produced from transcript loads and message actions. Task lists and status polling are for status, titles, running state, and workspace metadata. When investigating slow list refreshes or memory growth while switching tasks, first check whether raw messages or command output have been reintroduced into the runtime list, handle, or transcript metadata path.

Codex 0.147 history reads must follow the `historyMode` selected when the thread was persisted. The executor first reads metadata with `thread/read(includeTurns: false)`: `paginated` threads use `thread/turns/list(itemsView: notLoaded)` followed by `thread/items/list` for the complete items of each turn, while `legacy` threads use `thread/turns/list(itemsView: full)` directly. Legacy rollout stores do not support `thread/items/list`, so the executor must not force item pagination based only on the Codex version.

Codex filters `<codex_internal_context>` from history APIs, so Wework must preserve visible goal and continuation input by `clientUserMessageId` when sending it, then merge that presentation with provider items while loading the transcript. For pre-upgrade `legacy` conversations without a local presentation, the executor may restore the first request from the thread preview only when the first turn on the oldest page has no user message at all. It must not add the preview when that turn already contains text, image, or attachment messages.

### Pane Cache and Resource Lifetimes

The desktop workbench caches at most 10 ordinary panes and evicts them in least-recently-used order. An inactive pane that is no longer running releases transcript messages, historical DOM, pagination ranges, navigation indexes, and processing expansion state; returning to it reloads from the original runtime transcript.

Electron conversations use one `@tanstack/react-virtual` message-row virtualizer for every conversation size instead of switching implementations at a message-count threshold. While the user remains at the bottom, the virtualizer uses `anchorTo: 'end'` to follow the list end. After the user scrolls upward, it must switch to `anchorTo: 'start'` so streaming row growth cannot make TanStack Virtual keep rewriting the scroll position. Scroll snapshots are consistently represented as the distance from the viewport bottom to the list bottom. Its shared `ResizeObserver` measures mounted message rows. An active streaming message must remain in the virtual range even when it is outside the visible range and overscan, so its growth continues to reach TanStack Virtual's measurement pipeline; otherwise, replacing its estimated height with its real height when it remounts can corrupt the historical reading position. While the user remains at the bottom, height changes preserve the end distance. After the user scrolls upward, the list instead records the first visible text scroll anchor and its viewport offset, then restores that text anchor when streaming content is remeasured. This keeps bottom-follow behavior without allowing the text being read to drift upward during streaming. The rendered range keeps 2 rows of overscan on each side. Message rows no longer use `IntersectionObserver` as a second windowing layer; an individual oversized Markdown response retains independent chunk windowing to bound the DOM inside one visible message. Chunks whose rich Markdown is not mounted retain lightweight plain text so rapid scrolling cannot expose a height-only blank region. Remaining `IntersectionObserver` usage covers independent behavior such as bottom-follow state and attachment previews.

The desktop conversation scroller uses a DOM bottom origin: `scrollTop` is `0` at the newest message and becomes negative while moving toward history. Business state, scroll snapshots, turn navigation, and E2E assertions use distance-from-bottom or content coordinates and must not depend directly on a top-origin `scrollTop`. TanStack Virtual still uses top offsets internally, but that conversion belongs exclusively in `useBottomOriginVirtualizer`; business components must not perform their own top-coordinate conversion. On a task switch, the hook writes the new conversation's bottom distance in the same layout commit so the UI never paints a top position and corrects it on the next frame.

In non-split mode, the pane-stack parent owns the shared workbench content width and passes that stable value to a newly selected task pane. A pane's own measurement is only a fallback for startup, zero-width measurements, and split mode. The new pane must decide whether to dock the environment information panel from the shared width on its first frame. Rendering the chat at width `0` first and then subtracting the 320px side panel on the next frame causes a visible horizontal flash in the messages and composer.

A single assistant message may contain many tool blocks and be split into multiple `ToolBlocksDisplay` segments. Derived data that depends on the complete message, such as file-edit durations, must be computed once at message scope and then mapped into each display segment; each segment must not rescan the complete message. Use an empty-result fast path when the corresponding display blocks are absent, and avoid creating split arrays or sets while matching every block's tool name.

Each conversation stores only a bounded TanStack measurement snapshot alongside its distance-from-bottom scroll snapshot. Changes to this path must cover short and long conversations, streaming bottom-follow behavior, continuous measurement of offscreen streaming messages, text-anchor stability after scrolling upward, historical-position restoration, reopen after switching away, forced mounting for turn navigation, and cache eviction when a task is archived.

Terminal and built-in browser sessions are stateful active resources and do not follow ordinary pane eviction. A pane remains mounted while it owns a Terminal or browser tab so its terminal process and page session survive task switches. After the corresponding resources close, the pane is subject to the ordinary cache limit again. Changes to this boundary must continue to cover ordinary-pane LRU eviction, resource-pane retention, message-row virtualization, and the desktop memory E2E.

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

Live process-text, thinking, and plan block updates carry only `content_delta`; they must not resend cumulative `content` after every delta or at the completion boundary. A completion update normally carries only `status: done`. If the provider completion snapshot contains only an unstreamed suffix, the executor sends that suffix as one final delta. Wework coalesces consecutive updates for the same block within a browser animation frame before updating React state, preventing quadratic IPC copying and rendering pressure during long-running tasks. Streaming block updates are droppable bulk events: terminal events retain priority under app IPC backpressure, and transcript reconciliation restores authoritative content. The Electron main process must not write every `response.*` delta to stdout; a synchronous console write can block the Browser main thread and all window input when a terminal or parent process does not consume output promptly.

Streaming messages skip full Pretext height measurement and use a stable offscreen intrinsic height. Completed messages are measured precisely and cached. Height lookup first uses the message object and width, avoiding repeated full-text hashes for unchanged historical messages during every stream update. Stable props and memo boundaries also keep the composer, workspace actions, right workspace, and bottom terminal from rerendering for every text delta.

While the bottom Terminal panel is being resized, height updates are coalesced to browser animation frames and height transitions are disabled. This prevents high-frequency pointer events from causing excessive React updates and Terminal layout work. Releasing the pointer must commit the final height and restore the transitions used when opening or closing the panel.

Distinguish these cases when investigating streaming stalls:

- The frame rate is stable but output alternates between fast and slow: inspect stream `message` event intervals. Executor batching or network/IPC delivery gaps are usually responsible.
- Long frames, dense style recalculation, or Markdown parsing appear: check whether code bypasses the text buffer, destabilizes Streamdown component references, or reintroduces per-character DOM animation.
- GC time is unexpectedly high: verify whether DevTools has **Heap Allocations** enabled. That instrument can significantly amplify GC during longer recordings and should be disabled when diagnosing interaction smoothness alone.

Streaming-buffer unit tests live in `wework/src/components/chat/useBufferedStreamingText.test.ts`. Changes to the reserve or advance rate must continue to cover Unicode boundaries, non-append updates, and immediate alignment when streaming ends.

## Persistent Animation Rendering

Status spinners and text shimmers are persistent animations: they can keep the Web Content process busy even when there is no input or streamed message. Implement these effects so that each frame changes only compositable `transform` or `opacity`. Do not animate paint-bound properties such as `background-position` or `mask-position`, and do not rotate a complex stroked SVG directly.

A spinner should keep its SVG static inside a fixed-size HTML wrapper and animate the wrapper's `transform` with `will-change: transform`. A text shimmer should keep the base text normally rendered and use fixed highlight bands with staggered `opacity` animations to reproduce the left-to-right sweep. Both implementations must preserve `prefers-reduced-motion` behavior.

Do not infer compositor behavior from CSS property names alone. `will-change` is only a hint, and apparently compositable properties such as `clip-path` can still cause per-frame main-thread work in the Electron version that ships with Wework. After changing a persistent animation, capture the old and new implementations for at least 10 seconds under the same Electron version, element count, and window state, and verify:

- Pausing animations causes CPU usage to fall, establishing that the animation is causal.
- The new implementation no longer emits per-frame `Paint` or `PaintImage` events.
- `UpdateLayoutTree` and `Layerize` event counts and total durations no longer grow continuously with animation frames.
- Direction, period, color, dimensions, and visibility states match the previous effect.

If the replacement still produces continuous painting or layerization, revise the implementation again. Visual smoothness or an occasional reduction in average CPU is not sufficient evidence.

## Collected Data

When enabled, the diagnostics module records:

- Browser long tasks.
- Event loop lag above 120ms.
- A 5-second sample of memory, DOM node count, resource count, and visibility state.
- React root commit durations above 24ms.
- Manual mark events.

The latest 300 events are kept in memory and exposed through `window.__WEWORK_PERF__`. Diagnostics data is not uploaded to the server.

## Capturing Evidence

Release builds compile Electron DevTools support by default, while the main WebView remains non-inspectable so its native Chromium context menu does not contain Inspect Element. When the user selects **Open DevTools** from the hidden **Developer Commands** menu, the native command dynamically enables `webContents.openDevTools()` and opens the Inspector. This command is independent of the Performance Diagnostics switch and requires macOS 13.3 or newer. Built-in-browser child WebViews enable Inspector only in debug builds. On macOS, the Inspector is forcibly detached before its frontend is first shown, so F12 opens a separate window without docking, resetting the child dimensions, or covering the workbench. Release builds disable the child-WebView Inspector through an explicit build cfg. Set `WEWORK_RELEASE_DEVTOOLS=0` when a distribution must omit main-WebView Inspector support. To open the main-WebView Inspector automatically for a local diagnostic launch, use:

```bash
WEWORK_WEBVIEW_DEVTOOLS=1 /path/to/WeWork.app/Contents/MacOS/WeWork
```

After DevTools opens, run this when the app becomes slow:

```js
window.__WEWORK_PERF__.snapshot();
```

The snapshot includes the current URL, page visibility, DOM node count, memory snapshot, navigation timing, resource count, recent events, and Wework process-group data. macOS reparents Chromium XPC processes to PID 1; diagnostics use LaunchServices to associate the current Wework instance with its Web Content, GPU, and Networking processes.

Each process group reports both `rss_kib` and `physical_footprint_kib`. RSS includes shared mappings and reclaimable resident pages and is commonly much larger than actual memory pressure. Prefer `physical_footprint_kib` when investigating leaks or system resource usage, and treat RSS as a secondary residency metric. When comparing multiple snapshots, focus on:

- Whether `memory.usedJSHeapSize` keeps growing.
- Whether `processMemory.groups[].physical_footprint_kib` keeps growing after a task completes and cools down.
- Whether growth belongs to `webkit-webcontent`, `codex-app-server`, `executor`, or `main`.
- Whether `domNodeCount` keeps growing.
- Dense `longtask` or `event-loop-lag` events.
- Repeated `slow-react-commit` events.

The workbench's full-height sidebar and content-wide top bar should use ordinary semantic backgrounds instead of applying `backdrop-filter` to large persistent surfaces. These filters can cause Chromium to retain additional graphics backing stores for the entire region. When investigating Web Content memory, compare `physical_footprint_kib` before and after the change at the same window size and page state, and exclude the temporary reclaimable high-water mark created by DevTools heap snapshots from the steady-state baseline.

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
