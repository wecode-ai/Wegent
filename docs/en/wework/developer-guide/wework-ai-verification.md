---
sidebar_position: 39
---

# AI Verification Sessions

Wework can start an isolated development verification session so an AI can operate and assert against the real Electron application. It reuses the desktop E2E WebView control channel, never drives an external Chrome window, and does not attach to a developer's everyday Wework window.

## Idle Executor request regression

`idle-executor-requests` uses isolated real Electron and Executor instances with no tasks and no cloud connection. It reuses the shared runner's initial telemetry refusal, reloads the main window, and observes requests. Worktree capability discovery, telemetry configuration, and the shared SSE subscription must each occur once after reload. Foreground and close-to-background observation windows each last 6.5 seconds, crossing the five-second poll interval: pending-interaction discovery and Runtime identity checks must continue, without full task-catalog polling or repeated startup configuration. Known asynchronous bootstrap requests, such as plugin initialization, may finish; a fixed delay is not used to infer startup readiness.

Identity descriptions share only not-yet-dispatched requests within the same synchronous batch; post-operation identity checks still fetch fresh descriptions. Confirmed local Runtime telemetry policy is not rewritten on idle polls. Runtime, account, API, or policy changes resynchronize it, and failed writes retry. Work-list changes refresh task data only; device events and explicit refresh retain device discovery. Work events preserve an in-flight full cloud sync and coalesce into one fresh work read afterward. Bootstrap device and team synchronization is not discarded when the task-read revision changes.

Last-project restoration waits until the initial local work-list load settles; an earlier cloud-composed list must not consume that restoration attempt. Device and cloud catalogs may publish independently, without implying that local projects are ready.

```bash
pnpm --filter wework e2e:desktop --segment idle-executor-requests
```

The independent checkpoint is registered in an existing Core CI shard and does not require earlier scenarios. Local macOS arm64 verification took approximately 52 seconds including startup and cleanup, excluding the shared build. Its result directory contains `idle-executor-requests.json` with method names, timestamps, statuses, and necessary boolean flags only, never request parameters, headers, or query strings. Do not commit logs or screenshots.

## Desktop CPU regression checks

The existing Linux Core CI measures CPU for `idle-executor-requests`, `streaming-conversation-switching`, and `executor-stream-recovery`. The measurement spans the scenario's verification function, including any setup and reloads inside it. For example, the idle scenario's total includes its reload and follow-up verification. CPU time in milliseconds is reported separately for Electron Renderer processes and the main Executor process. Executor child processes are outside the current measurement scope. Both endpoints must identify the same measured processes. Collection failures and process changes are logged as unavailable samples.

Linux Core shards run the idle workbench and Executor stream recovery checkpoints in isolation before starting the shard's parallel checkpoints. This prevents concurrent desktop sessions from inflating the measured processes' CPU time.

[github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark) tracks baselines by checkpoint, runner OS, architecture, and CPU model. Scheduled or manually dispatched Wework E2E runs on `main` update the baseline. Pull requests and the merge queue only read it. When an existing shard runs the corresponding checkpoint, CI reports the current value, baseline, and ratio. With a baseline, CI fails when either process uses more than 150% of the baseline CPU time or the checkpoint produces no sample. Before the first baseline, CI can pass and reports any available samples.

## Periodic plugin recovery E2E

The `plugin-periodic-reconcile` checkpoint uses real Electron, Executor, Socket.IO, database, and plugin package storage. It discards one real plugin change notification, then verifies timer-driven recovery, persisted acknowledgements, device identity, and unchanged unrelated plugin content. Its isolated instances set `LOCAL_PLUGIN_RECONCILE_INTERVAL=90` and `LOCAL_PLUGIN_RECONCILE_JITTER=18` (seconds), with the existing `LOCAL_HEARTBEAT_INTERVAL=1` configuration preserving the assertion of at least 10 heartbeats. The checkpoint observes production reconciliation ticks and aligns fault injection to the current timer window when fixture setup crosses one, so setup load cannot force a longer interval.

Without overrides, production retains a 600-second base period plus a stable per-Runtime offset of 0–119 seconds and 30-second heartbeats. Invalid or non-positive integer values use the defaults. The test neither invokes reconciliation manually nor replaces the real timer.

```bash
pnpm --filter wework e2e:desktop:cloud -- --segment plugin-periodic-reconcile
```

The plugin account late-response E2E uses a unique `Server-Timing` diagnostic marker on the selected fault-proxy response while preserving its real upstream body bytes. Verification identifies the renderer's actual consumption of that response before checking stable current-account inventory. Browsers may record multiple fetch consumers for one HTTP response, so a time window containing exactly one entry cannot establish response identity. Protocol tests protect byte preservation and coalesced-consumer correlation; the existing desktop checkpoint still verifies real account/device boundaries.

## Conversation model restoration diagnostics

When full task data is selected, the feedback bundle's `context/task.json` includes `modelSelection`: `configured` is the configuration supplied to the model selector, `effective` is the configuration after default resolution, and `selected` is the current composer model. Missing snapshots remain `null`. Snapshots contain only model identity, resource ownership and a diagnostic fingerprint; arbitrary model options and authentication configuration are excluded.

The feedback dialog keeps the task selected when it opened. Its preview reads that task's complete transcript independently of pane refreshes during reconnection and conversation switches.

The `workbench.selection_restored`, `workbench.selection_changed` and `workbench.selection_seeded` events in `logs/app/model-loading.log` correlate scopes and models through numeric fingerprints. Fingerprints are diagnostic identifiers. The executor's `runtime task model selection updated` event records an in-memory assignment. The `runtime task get resolved link` and `runtime task transcript resolved link` events record the owning task's current model identity on reads. Assignment does not prove that a disk write succeeded.

`configured` is not the raw on-disk task record. Existing conversations receive configuration from the task summary or runtime handle; new conversations can receive project configuration or user preferences.

1. Export feedback before restarting.
2. Restart the app.
3. Export feedback before the first send.
4. Check the model identity read by the executor.
5. Compare the composer's configured, effective and selected models to distinguish missing records, default substitution and composer changes.

## Prepare desktop E2E prerequisites before startup

Write configuration that Codex caches, including model catalog overrides, in the scenario's `prepareApp` before launching the app and shared app-server. `human-interactions` declares `request_user_input_async` at this stage. Updating the configuration or deleting the disk cache in `verify` can leave the running process using the old catalog.

Windows CI runs desktop tests under a standard account. Compile the DingTalk protocol fixture into the workspace before switching accounts and pass it through `WEWORK_E2E_DWS_FIXTURE_BIN` for the stand-in scenarios to reuse, without relying on that account's Rust toolchain. Local runs without a prebuilt fixture still compile it during scenario preparation. This is protocol integration coverage; real DingTalk compatibility remains unverified.

## Shared Codex startup protection

The shared app-server startup watchdog must account for active turns and turns still preparing native threads. A peer waiting for `thread/start` does not yet have a thread ID, but must still be protected from restart. A client-scoped preparation lifetime is released on initialization, failure, or cancellation; active-thread records continue protection during model execution. This does not increase startup timeouts or resubmit existing turns.

The process-level protocol regression in `executor/tests/codex_app_server_contract/startup.rs` holds the second thread response behind observable file gates, crosses the real watchdog deadline, then releases it and verifies both turns complete. Executor and child-process IPC remain real while the Codex protocol service is synthetic; real Codex compatibility with the same fault injection remains unverified.

## Start a session

During builds, `prepare-codex-binary.mjs` downloads the locked version through native Node HTTP/HTTPS streams, follows redirects, and removes failed temporary files. Archives are extracted for use only after integrity verification. The download stream does not depend on the Undici parser used by Node's built-in Fetch, avoiding parser crashes that terminate the build process.

```bash
pnpm --filter wework ai:verify start
```

The command prints a session file path and a local control URL. It creates a separate Executor Home, projects directory, device ID, IPC socket, Electron app-data namespace, and diagnostics directory, then starts real Electron from the source application directory. Tasks, projects, application data, and the single-instance lock are not shared with release or other verification sessions. Logs are stored in `wework/test-results/ai-verify/<run-id>/`.

When the user explicitly selects their local Codex account, set `WEWORK_E2E_NATIVE_CODEX_HOME` to that signed-in native Codex directory. The existing native account mechanism supplies authentication to the isolated instance; never read, print or manually copy authentication contents. To reuse your own isolated data, `--executor-home` must be absolute, and `--device-id` explicitly retains that Home's device identity.

Before launching the app, new sessions record the actual auth path, whether an entry already exists and the native managed marker's metadata. Normal stop, controller shutdown and failed startup share ownership-aware cleanup: only newly created managed links or copies whose marker and file identity still match are removed. Native source accounts, pre-existing auth and user replacements remain intact. Legacy sessions without ownership records retain default private-Home cleanup; explicit reused Homes are conservatively preserved. An older link can be cleaned by stopping the original default session that owns it.

The native creator writes a versioned ownership marker binding the session nonce to file metadata, without auth contents. Session state uses a cross-process lock and atomic replacement; cleanup rereads the latest state so concurrent observers and stale snapshots cannot overwrite cleanup results. Unknown ownership protocols conservatively preserve auth.

## Shared desktop E2E runtime images

Shallow clones that check out the complete source tree omit `filter: blob:none`: the working tree needs every blob, so filtering only defers their download to a second promisor request during checkout. Only change classification retains full commit history with blob filtering to avoid downloading historical file contents. The shared runtime contract test checks that shallow checkout jobs do not introduce this extra request.

Standalone MinIO uses the shared API port allocator and excludes the pinned version's default console port, `13333`. Even with `MINIO_BROWSER=off`, that version checks port equality and exits; see its pinned [default](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/globals.go#L215) and [startup check](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/common-main.go#L502). The port regression starts allocation at `13333` and verifies that the resulting non-conflicting port can actually bind, rather than masking the conflict by restarting MinIO.

Non-draft PRs that trigger only Wework desktop E2E must also start the Backend Rust runtime producer in `e2e-tests.yml`; platform E2E eligibility alone is insufficient. The producer checks the content-addressed image first, reuses it on a cache hit, and builds and publishes it on a cache miss for the desktop build to consume. `ruby .github/scripts/test-backend-rs-e2e-runtime.rb` covers producer eligibility for platform, desktop, and draft PRs.

Linux desktop E2E builds and cache warmup consume the Rust Backend OCI image produced by `e2e-tests.yml`. Consumers must use the producer's exact `SOURCE_DIGEST` expression, including example sources. Hashing only the main program generates an unpublished image tag and eventually times out with `manifest unknown`. When changing runtime image inputs, run `bash .github/scripts/test-wework-core-e2e-runtimes.sh` to verify that both the desktop and warmup consumers match the producer.

## Operate and assert

Linux isolated desktops use `Xvfb -noreset` so the display remains connectable throughout the checkpoint. The default reset after the last client disconnects can close the listener between a short-lived `xprop` probe and Openbox connecting; see [Debian's lifecycle analysis](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1095028#43). Window-manager restarts or longer waits must not hide startup failures.

Pass the session path returned by `start` to every later command. Prefer stable `data-testid` selectors.

After Issue creation, finding the record in the API list does not prove that its detail UI has rendered. The shared `createAndAssignCloudIssue` flow uses `clickWhenEnabled` to wait for the detail assignee control to appear and become enabled before clicking, within the default step timeout. API persistence cannot substitute for control readiness; delays and reruns must not hide the race.

```bash
pnpm --filter wework ai:verify snapshot --session /path/to/session.json
pnpm --filter wework ai:verify fill --session /path/to/session.json \
  --selector '[data-testid="chat-message-input"]' --value 'verification text'
pnpm --filter wework ai:verify click --session /path/to/session.json \
  --selector '[data-testid="send-message-button"]'
pnpm --filter wework ai:verify wait-for --session /path/to/session.json \
  --selector '[data-testid="message-assistant"]' --text 'Complete'
pnpm --filter wework ai:verify stop --session /path/to/session.json
```

Supported operations are `snapshot`, `text`, `click`, `fill`, `press`, `wait-for`, `status`, and `stop`. Commands return structured JSON and exit non-zero when the WebView is unavailable, an element is missing, or an assertion times out.

## Security boundary

The controller listens only on `127.0.0.1` and creates a single-use Bearer token per session. The Vite environment enables the channel only for the development instance started by `ai:verify start`; normal development and production builds do not expose it. The session file contains the token, so treat it as short-lived local credential and never commit or share it.

## Control protocol

After startup, the WebView calls `/ready` and then short-polls `/commands`. The controller immediately returns `204` when the queue is empty; the WebView briefly throttles through `/control-tick` before polling again. After receiving a command, the WebView calls `/started` and `/results` in order to acknowledge execution and submit the final result.

`ai:verify` and desktop E2E share this protocol, so endpoint and polling semantics must remain aligned when either side changes. Do not convert `/commands` to long polling: it conflicts with the WebView control loop, leaves later commands queued, and surfaces as repeated timeouts. The controller must also remove a timed-out command from the queue so a later poll cannot execute stale work.

## Native application menu refresh

**View → Refresh** reloads the current Wework window with `⌘R` on macOS or `Ctrl+R` on Windows/Linux. The item remains available on task and settings surfaces and calls the current window's `webContents.reload()` directly.

The `application-menu` desktop CI checkpoint covers item presence, visibility in settings, control-channel reconnection after refresh, route restoration, and working workspace navigation. Focused unit tests cover shortcuts on all three platforms, window reload, and English and Chinese labels.

The `refreshFromApplicationMenu` test control command waits for `/results` acknowledgement before activating the real native menu item, so renderer unload cannot lose the command result. A control-protocol unit test delays acknowledgement to verify this ordering.

Settings preserves the active workspace tab in the background. **Work → Tasks / Project spaces** must reselect the target tab and restore its content route from settings, even when that tab is already active; ordinary workspace navigation still avoids redundant selection.

Settings routes never overwrite a workspace tab's kind or content route. Reloading settings initializes ordinary workspace tabs while the application route continues to display settings, so returning to a workspace cannot reopen settings.

Persisted-tab validation excludes invalid settings entries while retaining valid workspace tabs.

## Native context menus

Electron does not create a WebContents context menu automatically. The Wework Electron main process listens for `context-menu` centrally and builds native menus for the main window, workspace windows, and auxiliary windows.

- Image menus retain copy-image, open-image, and local-file actions.
- Editable contexts must read `params.isEditable` and `params.editFlags`, use Electron's native `undo`, `redo`, `cut`, `copy`, `paste`, `delete`, and `selectAll` roles, and pass `params.frame` to `menu.popup`.
- Selected text outside an editor uses the native `copy` role. When no meaningful action exists, do not show an empty menu, so React components can keep their own business context menus.

When changing this path, run `wework/electron/src/host/image-context-menu.test.ts`, then verify menu presentation, enabled states, and paste behavior in a real input inside an isolated Electron session. WebView DOM snapshots do not include a native macOS `NSMenu`; a synthetic `contextmenu` event or browser-only screenshot is not a substitute for real desktop verification.

## Fixed tab window restoration

When a fixed tab is assigned to a separate window, Electron restores its window identity and content route from local preferences. The restored URL must use the shared `resolveDshAppRoute` helper to add the `/wework/app/` prefix while preserving task or project query parameters, `workspaceTab`, `workspaceTabTitle`, and the fragment. Loading an unprefixed content route bypasses the Wework application deep-link entry point and prevents the restored window from displaying correctly.

The desktop CI `workspace-tabs` checkpoint covers detaching a fixed tab and restarting the application. It asserts the restored window route, tab identity, fixed state, and a visible composer that accepts input. Run focused verification with `pnpm --filter wework e2e:desktop --segment workspace-tabs`.

## AI workflow

An AI should start with `snapshot` to confirm the route and available `data-testid` values, make the smallest required interaction, and use `wait-for` plus `snapshot` or `text` to verify the result. Always call `stop` when finished. On failure, keep the session directory and inspect `app.log`.

## Record verification video

To keep a video of the verification steps, put FFmpeg with `libx264` on PATH. Use `start --record true` to begin recording when the main window is ready. The first frame is captured before the session path is returned. For an existing session, use `record-start` to begin a clip and `record-stop` to finish it. You can start another clip as needed.

```bash
pnpm --filter wework ai:verify start --record true
pnpm --filter wework ai:verify record-stop --session SESSION
pnpm --filter wework ai:verify record-start --session SESSION
pnpm --filter wework ai:verify stop --session SESSION
```

`record-stop` saves the video and prints its path. If recording is still active, `stop` saves the video before closing the session and prints the video path. Each clip is a separate MP4 in its session directory under `wework/test-results/ai-verify/`. If frame capture fails mid-recording, the recorder finalizes the frames already captured and reports the saved path with the error.

Recording samples the isolated Electron main window at five frames per second, including across page reloads, without macOS Screen Recording permission. It excludes OS dialogs, native menus, separate windows, and audio. Keep the video with the assertion results and review the footage for sensitive information before sharing it. Keep recordings and session files out of Git.

## General DevTools access and performance analysis

Isolated verification instances expose authenticated CDP through the Electron main process. Commands remain available while the renderer is paused at a breakpoint. Ordinary application instances do not register this endpoint. Enumerate targets and substitute a returned `id` for `ID`:

```bash
pnpm --filter wework ai:verify start
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"targets"}'
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"command","target":ID,"method":"Schema.getDomains"}'
pnpm --filter wework ai:verify performance-start --session SESSION --target ID
# Reproduce the interaction using existing click, fill, press and wait-for commands.
pnpm --filter wework ai:verify performance-stop --session SESSION --target ID --output report.json
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"detach","target":ID}'
pnpm --filter wework ai:verify stop --session SESSION
```

The `devtools` command accepts any `Domain.command` supported by the instance, `params`, and an optional child `sessionId`. There is no domain allowlist. Use Network response bodies and request data, Runtime object properties, Debugger sources and breakpoints, DOM, CSS, HeapProfiler, Tracing, or other CDP domains directly. Obtain worker/frame sessions through `Target.setAutoAttach` or `Target.attachToTarget`. Availability depends on the bundled Chromium/Electron version; this transport does not implement the DevTools panel UI or its extensions. See the [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger).

Use `--file request.json` for JSON input and `--output result.json` for large responses. Enable the desired domains, then read protocol events with a non-destructive cursor:

```bash
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"command","target":ID,"method":"Network.enable"}'
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"command","target":ID,"method":"Runtime.enable"}'
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"events","target":ID,"after":0,"limit":1000}' --output events.json
```

Pass `next` as the next `after`; `latest` identifies the current end. Each target retains up to 20,000 events or 32 MiB. `lost` reports events evicted since the supplied cursor. Drain frequently for high-volume capture. For large traces, use `Tracing.start` with `ReturnAsStream`, followed by `IO.read` and `IO.close`. Unexpected detachment retains buffered events and the `Inspector.detached` reason; explicitly detach before reconnecting. Opening the target's DevTools panel may detach Electron's debugger.

The performance convenience commands use this same transport to capture CPU sampling, timeline, network, console, exceptions and scripts. Stopping automatically writes:

- `report.json`: sampled self/inclusive CPU costs with source locations, long tasks and timeline totals per process/thread, slow requests with initiator stacks, redirects/failures/pending requests, console, exceptions and before/after metrics.
- `report.json.evidence.json`: the original CPU profile, Chromium trace and protocol events for further investigation.

Script-declared source maps resolve generated CPU locations to original files, lines and columns. Isolated E2E builds generate source maps; normal builds do not expose source as a result of this change. Inline, file and network source maps are supported, with network maps loaded through CDP. Mapping failures retain generated locations and report errors; use `Debugger.getScriptSource` to investigate further. CPU costs are sampled. Never add parent/child inclusive costs or nested trace durations. Nonzero `lostEvents` or `traceDataLoss` means incomplete evidence; shorten capture or adjust generic collection. Convenience recording profiles the root target; profile worker sessions separately using CDP.

Retrieve network bodies and console remote-object properties on demand using CDP; the report does not expand them automatically. Events are captured after their domains are enabled. Diagnostics may include sensitive request headers, payloads and logs. Keep them local and out of Git. Release sessions with `detach` and always clean up the isolated application with `stop`.

### User story coverage

The `devtools-performance` checkpoint runs in real Electron: discover a target, record and reproduce a known CPU hotspot, map it to original source, capture real HTTP/console/exception evidence, inspect DOM, command a worker child session, resume a paused renderer, then detach and reconnect. Invalid protocol commands and duplicate recording must fail without corrupting the connection. It is included in an existing core CI shard without adding a CI job.

```bash
pnpm --filter wework e2e:desktop --segment devtools-performance
```

Once CPU profiling stops successfully, trace collection, parsing or report-write failures release recording state while preserving the original error, so another recording can start. A failure to stop the profiler retains unconsumed state. The `devtools-performance` checkpoint also triggers a real output-directory write failure and verifies that a subsequent recording starts and completes.

A successful explicit `detach` discards unfinished recording state for that target, allowing cancellation or recovery after an unexpected disconnect. Failed detaches retain state. The real Electron checkpoint also detaches during a recording, then starts another recording and generates its report.

All desktop checkpoints use a `desktop-control` registry within their result directory for on-demand diagnosis of their isolated instance. Native macOS process snapshots read PID parent relationships first, then collect detailed metrics and command lines only for the Electron process tree, keeping unrelated process arguments out of the collection buffer.

### Renderer CPU and JS heap benchmark

On macOS, compare the baseline and candidate on the same machine with the same build configuration. The commands launch isolated Electron and the real executor. A test model emits 120 Markdown chunks at 100 ms intervals. The benchmark verifies that the first chunk appears while streaming and waits for the last chunk to appear. The isolated window uses the foreground rendering path without taking desktop focus. The report's `window` records native activity, document visibility, and focus.

```bash
pnpm --filter wework ai:verify:electron:build
pnpm --filter wework profile:renderer --check
pnpm --filter wework profile:renderer --history --check
pnpm --filter wework profile:renderer --capture
pnpm --filter wework profile:renderer --processes
```

- `--check` fails at idle CPU ≥ 10%, single-task CPU ≥ 15%, or sampled peak JS heap ≥ 200 MB (200,000,000 bytes). With no argument, the command reports measurements. CPU is cumulative CPU time across the isolated window renderer PIDs divided by elapsed wall time, with 100% representing one logical core. The idle window is about seven seconds. The task window runs from the start of the model response until the last chunk is visible. The benchmark samples V8 used heap every second without forcing GC.
- `--capture` uses the existing performance recording and writes `renderer-performance.json` and raw evidence. The `caller` field on native frames identifies JavaScript that triggered work such as layout. Recording adds overhead. Run `--check` separately to verify the limits. All modes save `renderer-threshold-measurements.json` in the test directory printed in the console.
- `--history` completes 16 persisted conversations in sequence and samples the heap after each one, then starts the benchmark task in the same renderer. It uses reproducible test model responses. `historicalTasks` records the conversation count in the report.
- `--processes` records app process snapshots while idle, mid-stream, and after completion. Inspect `processSamples` for the main process, renderer, GPU, executor, and child processes. The snapshots report OS or Electron CPU samples. Run `--check` separately for threshold verification. Shared memory pages may appear in multiple per-process measurements.
- To investigate a heap peak, identify the operation from the phase in `heapSamples`. If the heap drops quickly after natural GC, use Allocation sampling in Chromium's Memory panel to find call stacks allocating short-lived objects. Rerun the threshold check with allocation sampling disabled.
- For long-lived memory growth, switch tasks repeatedly with the same history in an isolated instance, record JS heap usage, and take two heap snapshots in Chromium's Memory panel. Compare object counts and retained sizes, then inspect `Retainers` for reachable paths, including detached DOM, closures, and caches. Detach CDP recording for the target before opening the Memory panel. Keep reports and snapshots local.

### Workbench resource budget

These proposed targets describe a steady-state single-window workbench. Profile startup, updates, indexing, embedded browsing, file previews, and local models under their own workloads.

| Scenario | Longer-term target | What to measure |
| --- | --- | --- |
| Visible window at idle | About 1–3% renderer CPU and about 5% or less across desktop UI processes | Measure visible and background states after startup settles. Express CPU relative to a logical core and check background wakeups. |
| One plain-text streaming task | About 8–12% renderer CPU | At ten chunks per second, this gives the renderer 80–120 ms of CPU time per second. Watch first and continuing text presentation, bottom following, and manual reading anchors. |
| Single-window JS heap | About 100 MB for a new conversation and about 120–160 MB with typical history | Compare the same dataset, cadence, and phase. History stays available from persistent storage. The heap should stabilize after repeated task switches. |

The main process handles windows, IPC and runtime coordination. The GPU process handles compositing and rendering. The executor and task subprocesses handle model connections, commands and tools. Plain-text streaming adds limited data, so document-wide style invalidation and full-page work on each update warrant investigation. For tool-heavy tasks, measure executor and subprocess activity and disk usage separately. Read JS heap, native renderer memory, GPU resources and other process memory as separate measurements. GPU-process CPU measures CPU time. [Electron process metrics](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics) [Chrome DevTools memory diagnostics](https://developer.chrome.com/docs/devtools/memory-problems)

### Diff preview CPU and workbench memory regressions

The diff preview uses Pierre virtualization. Keep line callbacks, render options, annotations and layout metrics stable; owner refreshes or replacement event handlers must not rebuild unchanged code DOM. Actual option, diff and annotation changes must still render. `FileChangesPatchDiff.test.tsx` checks node identity across repeated refreshes and cleanup on unmount with real Pierre instances.

Define workbench memoized callbacks in independent Hook lexical scopes instead of the Provider's large render scope. Otherwise callbacks whose dependencies change at different rates can retain historical task, lifecycle and work-list snapshots through their shared closures. `workbenchCallbackLifetime.test.tsx` triggers real GC through Inspector, uses weak references to verify snapshot collection and guards against defining `useCallback` directly in the Provider again.

Interpret CPU samples, HTML parsing duration and process memory separately. Heap object sizes do not equal Activity Monitor process memory; one heap snapshot establishes retaining paths, not a memory growth rate. Keep analysis files local and never commit user traces or heap snapshots.

## PR-scoped Bombadil exploration

Use Bombadil 0.7.10 on macOS ARM64 or Linux and set BOMBADIL_BIN to its executable. Preview selection with `pnpm --filter wework ai:verify bombadil --base origin/main --plan true`. Run the same command without --plan, with `--seconds 30`, or explicitly select `--suite appearance` or `--suite workbench`. Obtain the binary from https://github.com/antithesishq/bombadil/releases/tag/v0.7.10.

The base plan uses committed merge-base-to-HEAD paths, including deletions and both sides of renames. Uncommitted work requires an explicit suite. The map in scripts/ai-verify-bombadil.mjs selects appearance changes, workbench/chat/tab changes, and both suites for shared UI or host changes. Unmapped Wework/packages paths are reported as coverage gaps and prevent automatic execution from claiming a pass. Extend the specification and map for new features. Selection is candidate coverage, not correctness evidence.

Each suite owns a fresh real Electron and Executor session. Only explicit Bombadil startup opens an ephemeral loopback debugger; existing Executor Homes and ambiguous page targets are rejected. Setup dismisses the isolated privacy prompt and establishes the feature prerequisites. Suites run serially with a 1–600 second budget each; success, failure and timeout clean up the session. Model execution and cloud authentication are not exercised.

Results under `wework/test-results/bombadil/<timestamp>/` include summary.json, logs and native traces. Failed checks, cleanup failures and zero-action runs cannot pass. Traces can contain screenshots and page content: keep them local, do not commit them, and never upload session.json, credentials or the entire ai-verify directory. Any CI integration needs a bounded budget. Exploration does not replace deterministic regression, permission or release verification.

The Wework Bombadil exploration GitHub Actions workflow is manual-only. Select the PR branch and provide the base ref (origin/main by default) and seconds per suite. Ordinary PRs gain no automatic exploration. The workflow verifies the pinned download SHA-256 and publishes only summary.json to the step summary, never raw traces or authentication directories.
