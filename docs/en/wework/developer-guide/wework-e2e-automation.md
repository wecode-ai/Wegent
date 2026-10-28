---
sidebar_position: 34
---

# E2E Automation

Desktop E2E fixtures use `GPT 5.6 Luna`. Real runtime catalogs advertise both `GPT-5.6 Luna` and `GPT 5.6 Luna`, so default-model selection assertions accept these two display names while retaining model ID and provider checks. Task restoration assertions retain the fixture's original display name.

Desktop checkpoint cleanup retains `backend-rs-logs/` so CI can upload Rust gateway startup logs. Settings follows the current global route while retaining the original tab's application route, allowing Back to restore the application.

Wework provides a dedicated Playwright E2E entrypoint and a test-only frontend automation bridge for operating the Wework Vite/React frontend in CI. The default entrypoint runs in browser mode, which covers most frontend interactions; the desktop task-flow E2E below covers native-window and task-execution behavior.

Issue MCP attachment coverage uses the shared `setup-minio-e2e` Action on Linux and Windows to build and verify the same pinned real MinIO version. Only main writes caches; scenarios use the platform executable through `WEWORK_E2E_MINIO_BIN`.

The first model-routing task and real Harness CLI launch use the workbench startup budget. Streaming scroll waits for the model request before applying the original ten-second UI assertion. After changing projects, wait for the execution mode control to become available. Scroll moved board cards into view before checking result visibility, and use the responsive view helper for cloud Stand-in navigation.

Numeric Process Explorer filters match the exact PID, excluding matches in other processes' launch arguments or PID substrings. Text filters still search process names and launch details. The application-menu checkpoint retains its assertion that filtering by the application PID excludes unrelated helpers.

## Running Tests

Install the Playwright browser before the first run:

```bash
pnpm --filter wework exec playwright install chromium
```

Run Wework E2E:

```bash
pnpm --filter wework e2e
```

Run the real desktop task-flow E2E:

```bash
pnpm --filter wework e2e:desktop
```

Run only the cloud-project desktop E2E:

```bash
pnpm --filter wework e2e:desktop:cloud
```

Run only the plugin marketplace, install, chat-use, and uninstall flow:

```bash
pnpm --filter wework e2e:desktop:plugins
```

Run only the embedded-browser Agent operation regression:

```bash
pnpm --filter wework e2e:desktop:embedded-browser
```

Run the desktop memory regression on macOS, including streaming growth and the whole-process check with 10 concurrent tasks:

```bash
pnpm --filter wework e2e:desktop:memory
```

Run only the regression that keeps “Thinking” below already-visible streaming assistant text and removes it after completion:

```bash
pnpm --filter wework e2e:desktop:streaming-text
```

The command starts a test-only Vite server through `wework/playwright.config.ts`:

```bash
pnpm exec vite --host 127.0.0.1 --port 4174 --mode e2e
```

It also starts Responses API, Sites upstream, and Connector upstream mocks:

```bash
node e2e/utils/mock-response-api-server.mjs
node e2e/utils/mock-sites-upstream-server.mjs
node e2e/utils/mock-connector-upstream-server.mjs
```

Default configuration:

- `VITE_WEWORK_E2E=true`
- `VITE_WEWORK_RUNTIME_MODE=backend`
- `VITE_LOGIN_MODE=password`
- `WEWORK_RESPONSE_API_MOCK_URL`: `http://127.0.0.1:9998`
- `WEWORK_SITES_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9997`
- `WEWORK_CONNECTOR_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9996`

All three mock ports can be overridden with matching `*_PORT` environment variables: `WEWORK_RESPONSE_API_MOCK_PORT`, `WEWORK_SITES_UPSTREAM_MOCK_PORT`, and `WEWORK_CONNECTOR_UPSTREAM_MOCK_PORT`. If a port is overridden, tests can also receive the full matching URL environment variable directly.

Tests do not mock backend APIs. When Backend is not running, the login-page smoke test only verifies that the frontend renders the login entrypoint. Business flows after login must start a real Backend and required services in CI.

## Desktop Task-Flow E2E

`wework/e2e/desktop/task-flow.e2e.mjs` covers the real task lifecycle in a local workspace and lets product distributions inject an optional desktop scenario:

1. Builds and starts the real Electron Wework application, opening an isolated workspace with `--open-workspace`.
2. Starts the real `wegent-executor` sidecar, which starts a real `codex app-server`.
3. Fills in a task and clicks send in the native WebView, then waits for the real conversation to render.
4. Verifies the request issued by Codex to the model service, the workspace file written by a real Codex tool call, and the final UI response.
5. Sends a follow-up in the same conversation and verifies its request and rendered response.
6. Starts a streaming response, cancels it through the desktop UI, verifies the stopped task state and rendered stop notice, then verifies the composer accepts a subsequent message.
7. Forces one model failure, clicks retry in the rendered error card, and verifies the retried request and final response.
8. Creates a short two-turn conversation, switches to a new conversation, reopens the original conversation, verifies that both user messages, both assistant messages, and all four unified virtual rows remain mounted, and confirms that the first message stays near the top of the viewport instead of losing content or leaving a large virtual-list gap.
9. Dynamically loads a product scenario when `WEWORK_E2E_DESKTOP_SCENARIO_MODULE` is set. The public runner supplies only HTTP, WebSocket, control, and diagnostic lifecycles; it contains no concrete product protocol or assertions.

The test does not simulate Wework, Executor, or Codex. To keep regression results deterministic and avoid requiring a real provider account, it starts only a loopback model service implementing OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. Each interface runs a text response plus a send → `apply_patch` → tool result → completion lifecycle, while real Codex executes the tool in the isolated workspace.

Reply predictions and their image-description requests are dispatched independently of the foreground scenario. A previous conversation's background image request can arrive after the protocol matrix starts. The model fixture identifies it first, retains the image-description protocol checks and response, and leaves matrix state unchanged. `desktop-reply-prediction-fixture.test.mjs` covers this cross-scenario path; foreground endpoint and model ID assertions remain intact.

The model protocol matrix defines 18 combinations across execution location, model source, and protocol:

- Local execution covers local custom models, built-in Codex models, and cloud Model CRDs across all three protocols, for 9 complete text and tool lifecycles.
- Cloud execution also covers local custom models, built-in Codex models, and cloud Model CRDs across all three protocols, for 9 complete text and tool lifecycles.
- The first local-custom-model-to-cloud-device combination verifies the synchronization confirmation, target Executor catalog write, and cloud Codex restart. All three local-model protocols must then complete their text and `apply_patch` tool lifecycles.

Matrix submissions use a 10-second timeout. If the composer already displays a submission error, the runner throws that exact error immediately. Otherwise, a stalled protocol stage reports its current stage and captured requests instead of waiting through the general UI timeout.

`e2e:desktop:streaming-text` runs an isolated streaming-message state regression through a scenario module. It uses the real Electron renderer, Executor, and Codex app-server while a loopback Responses SSE keeps a partial reply active. The scenario first streams one assistant item as `final_answer` and completes the same item as `commentary`. It verifies that Executor sends `response.block.created.replacesItemId`, allowing the frontend to atomically migrate the visible assistant text into a process block so the page contains one process copy and no final-answer copy. The scenario then verifies that streaming reasoning appears as “Thinking · summary” and that the reasoning summary and its placeholder are removed after completion. It starts a long-running command and confirms that the tool-row duration continues increasing after switching tasks while the tool-group header does not show a turn-wide aggregate duration. The scenario next builds a long multi-turn conversation beyond the virtualization threshold and verifies the “Thinking” position, user scroll anchor, streaming growth, and viewport stability after reopening the task. It uses `scrollFromBottomAsUser` to move a fixed distance upward from the bottom, then combines `startScrollStabilitySampling` and `getScrollStabilitySample` to record anchor geometry, DOM changes, and real `scroll` events while response chunks arrive. The gate requires no back-and-forth anchor movement and no programmatic scroll events after the user stops. It also verifies that the waiting state disappears after completion. The scenario retains screenshots for phase reclassification, reasoning, tool timing, ready, streaming, and completed stages; its scenario-specific Codex configuration disables plugin extensions to isolate direct message streaming.

`e2e:desktop:embedded-browser` runs the embedded-browser Agent operation regression through a scenario module. It uses the real Electron renderer, Executor, Codex app-server, and browser MCP server, opens a local fixture page, and verifies the Electron `WebContentsView` bridge control path. The scenario covers bridge identity lookup, authenticated bridge requests, page open, structured `inspect`, `fill`, `click`, `wait`, `scroll`, `screenshot`, `capabilities`, high-risk action approval, and combined MCP tools such as `open_and_inspect` and `wait_and_inspect`. It also starts a long `waitFor` and then verifies an independent `click` is not blocked, preventing bridge concurrency regressions. When local-file support changes, the scenario also opens a `file://` HTML fixture, Markdown and extensionless text fixtures, and a local folder fixture through the bridge, and verifies that an unpreviewable local file shows a toast instead of entering the download list. Results are written to `embedded-browser-agent-result.json`.

The `conversation-state` checkpoint keeps the reading paragraph visible before and after opening a file panel. Shared viewport restoration incorporates reader movement into the same semantic anchor baseline, so scrolling away from the bottom cannot make a programmatic correction look like native range clamping and apply the same layout shift twice. `useReaderViewportAnchor.test.ts` reproduces the CI scroll coordinates and 48px height change across consecutive restorations; existing E2E geometry assertions remain unchanged.

The `renderer-storage` checkpoint writes model, draft, and layout `localStorage`
fixtures in the real packaged Electron app, flushes the persistence queue, and
restarts Core DSH. It requires the page origin after restart to differ from the
original origin before checking that all three values were restored. This makes
the regression exercise desktop persistence across origins instead of an
ordinary read within the same renderer process.

The main desktop flow's short-conversation layout regression stores `short-conversation-00-ready.png`, `short-conversation-01-prompt-filled.png`, `short-conversation-02-completed-top-aligned.png`, and `short-conversation-layout-metrics.json`. The final screenshot and metrics are captured after switching away and reopening the conversation. The gate requires the first message to remain within `160px` of the message viewport's top edge. For focused local diagnosis, run `node wework/e2e/desktop/run-checkpoints.mjs --short-conversation-only`; the same check remains part of the regular `e2e:desktop` flow rather than a separate CI entrypoint.

The `collaboration-runtime-reconciliation` Core checkpoint runs independently and creates its own isolated cloud project, Issue, agent, and real Executor. A transparent WebSocket proxy holds actual completion events to cover snapshot-first, final-event-first, and terminal transactions contending on a real MySQL row lock. Each order checks the complete final text in the database, the Issue UI, and after reload. While a continuation's model response is held, it replays duplicate, reordered, unsequenced, and empty old completion events. Every replay waits for the real backend acknowledgement before asserting that the new turn, workflow, and execution capacity remain unchanged. The proxy only schedules transport; every component except the model service is real. Cleanup releases the model, transaction locks, and proxy connections.

The `runtime-input-answer-persistence` Core checkpoint answers real MCP elicitation forms in the main workbench pane and a temporary chat. The Executor, Codex app-server, MCP server, desktop automation transport, and work-list refresh stay real; only the model service is mocked. Executor request gates hold the accepted answer after the real response and hold the terminal continuation so the terminal history deterministically arrives before the work-list refresh completes. The checkpoint asserts that the full answer summary remains visible before and after the refresh. It also verifies that a transport failure and a stale executor rejection never mark the answer as accepted, and that archiving while acceptance is pending does not restore the answer.

The main desktop runner also supports execution through ordered checkpoints.
The checkpoints are `mcp-apps`, `remote-device-onboarding`, `workspace-tabs`,
`cloud-project-creation`, `cloud-space-mention`, `priority-filter`,
`telemetry-consent`, `automation-lifecycle`, `project-automation`,
`project-assignment-notification`, `offline-local-project-space`,
`core-dsh-plugin-management`, `plugin-auto-update`, `plugin-workspace-publication`,
`project-ai-settings`, `model-routing`, `permission-modes`,
`runtime-input-answer-persistence`, `computer-use`,
`task-status-sync`, `task-board-association`, `core-task-flow`, `task-attachments`,
`cloud-git-worktree`, `cloud-worktree-capability`,
`cloud-worktree-create`, `cloud-worktree-queued-cancel`, `cloud-worktree-tools`,
`cloud-worktree-archive-restore`, `context-compaction`, `runtime-task-queue`,
`executor-stream-recovery`, `running-conversation-history`,
`codex-notification-isolation`, `split-workbench`, `native-window-startup`,
`native-window-chrome`, `renderer-storage`, `tray-lifecycle`, `window-lifecycle`,
`goal-lifecycle`, `supervisor-lifecycle`, `resilience`, `conversation-state`,
`temporary-chat`, `workspace-attachments`, `rendering-extensions`,
`change-request-status`, `claude-runtime`, `local-file-preview`, `local-harness`,
`harness-apps`, `browser-multi-tabs`, `embedded-browser`, and
`browser-toolbar-actions`.
`--segment <checkpoint>` performs common startup and project
initialization, then runs only the selected checkpoint.
`--from-segment <checkpoint>` starts there and continues through every later
checkpoint. When upstream checkpoints are skipped, each checkpoint establishes
its own minimal fixtures instead of depending on tasks or UI state created only
by the complete flow. PR CI builds the smallest segment matrix for the changed
feature paths. Shared desktop infrastructure, merge queue, scheduled runs, and
`ci:all` still run the complete desktop suites. Core and Cloud shard definitions
live in `.github/scripts/classify-wework-desktop-e2e.sh`. Linux Core and Cloud jobs
run at most four isolated checkpoints concurrently; actual concurrency also
depends on the shard's checkpoint count. Each checkpoint owns its database,
Redis, ports, and runtime directories, and Harness runtimes are extracted once
before the shard starts. The former intensive-runtime and Collaboration groups
therefore no longer serialize entire checkpoints. macOS checkpoints that require
the native desktop foreground still use an exclusive resource lock.

`split-workbench` keeps its fixed three-second drag interaction assertion on a
dedicated Linux shard so competing full-stack instances do not change the benchmark's
CPU allocation. It retains all functional assertions and logs pointer movement,
pointer-up dispatch, and split readiness timings. Other functional shards still
allow up to four instances.
Core and Cloud matrix jobs also provide suite-level parallelism across runners.
Core uses 10 shards, with Windows sharing the same matrix, and Cloud uses 8.
Combining short shards reuses container initialization, checkout, artifact
downloads, and runtime preparation without increasing checkpoint concurrency
within a runner. The two Core benchmark shards and three Cloud account-auth and
long-plugin-list shards remain separate. The concurrency limit must accommodate
the complete matrix in one scheduling wave; classifier regression tests enforce
both the shard budget and this constraint. Shared runner capacity can still
introduce external queueing.
Lint, unit-test, platform E2E, and desktop E2E summary jobs use
`always() && !cancelled()`: failures still produce a summary, while cancellation
stops superseded summaries from waiting for runners and blocking newer runs.
Cleanup and diagnostic upload steps retain their existing cancellation handling.

Step timings from successful runs `39920301020` and `39920742402` separate test
work from setup overhead. In the first sample, non-test steps across 42 shards
consumed about 60 runner minutes, or 31% of shard execution time; setup overhead
was higher in the second sample. The final 18 shards remove 24 setup cycles.

Checkpoint timings from `39930854745` drive the final allocation: longest tasks
start first and cumulative work is balanced, while CLI and Electron preparation
remain shared. That run's `workspace-tabs` failed early because Issue creation
did not wait for readiness after navigating to the board. Its successful
116-second duration from `39920301020` supplies the estimate instead of its
incomplete failure duration. The click uses the existing `clickWhenEnabled`
with the default ten-second timeout and preserves all business assertions.
The 112 ordinary Core checkpoints total 10,246 seconds, distributed into eight
shards of 14 tasks with four concurrent workers each. Predicted durations are
323–332 seconds; a ninth shard only reduces the maximum to 320 seconds.
The 37 ordinary Cloud checkpoints total 5,769 seconds, distributed into five
shards with predicted durations of 291–339 seconds; a sixth shard only reduces
the maximum to 321 seconds. Two Core and three Cloud shards remain isolated.
These scheduling estimates exclude per-shard setup and runtime resource
variation and are not measured savings.
Background-terminal history verification reads the first visible xterm row's
`aria-posinset`, then waits for each native PageUp to strictly decrease that row
until reaching the start of history. Each operation retains the default
ten-second timeout, all twelve initial output lines are asserted, and native
PageDown restores the viewport. A single ten-second deadline cannot bound many
page operations: control latency under concurrent CI can exhaust it while
history remains intact. Focused regressions cover a slow control channel, stalled
scrolling, and missing history.
`background-terminals` runs alone first within its existing shard; the remaining
checkpoints then regain their configured concurrency. Native keyboard actions
avoid CPU contention from other full desktop environments while preparation is
reused, without another matrix job, a longer ten-second step budget, or fewer
history and native-input assertions.
Shards are balanced from observed CI durations; a new or
materially slower checkpoint requires rebalancing instead of
removing coverage or rerunning failures.
The Issue notification read scenario waits for the close button to disappear after
closing a drawer before interacting with the board. Closing commits after the exit
animation; clicking a covered card earlier can let the delayed close affect the
new Issue. Task lifecycle regressions cover delayed running snapshots for both the
same and a prior provider turn. A confirmed settled turn cannot restart from stale
metadata, even when its update timestamp exceeds a second-precision completion;
the executor can still confirm the start of a different new turn.
An earlier completion cannot settle a known newer live turn. Goal execution between
turns remains independent of turn completion and is confirmed by the executor.
Read-only board drag checks scroll the source card into view after grouping changes
and reloads. Owner lane-order checks and cross-column reload checks also scroll
each card into view before checking visibility. Windows can have a narrower available viewport, so priority and tag
columns cannot all be assumed visible. Permission and persistence assertions remain.
Tracked task activity composers also scroll into view before visibility checks.
Executor environment verification resolves real filesystem paths through Node to
compare Windows native paths with the Bash working directory correctly.
Notification tab navigation waits for the project URL to commit before recording
or comparing it; a rendered project title does not imply its asynchronous route
has committed. Project-route preservation and tab-reuse assertions remain enabled.
Foreground plugin installation pauses automatic page updates and synchronization
until completion, preventing stale inventory from triggering a full replay.
Cloud restoration retains the resolved socket endpoint. Runtime-token rotation
updates shared executor credentials while preserving the device connection and
RPC route, avoiding lost transcript requests during reloads. Traditional tasks read
rotated runtime tokens only while backend, socket, and session credentials match
the original connection; switched or disconnected sessions reject old tasks.
Goal restoration preserves the
known turn and rejects a different stale streaming history.
Background device refreshes retain app registration aliases that match the current
native runtime identity, so cloud comment addresses and native completion events
share one lifecycle. Registrations for older runtimes remain excluded.
If delivery finalization races the personal-task start transition, re-read the
Issue once after a version conflict and recompute the update, preserving completed
Issues. Web task joins resolve streaming state before reading messages so a stream
finishing during restoration cannot leave an old blank message snapshot.
Stand-in dispatch pins large create/send futures on the heap at their shared
boundary, keeping nested async state machines from overflowing Windows Tokio
worker stacks with exit code `0xC00000FD`. Regressions enforce Clippy's
[16 KiB large-future boundary](https://doc.rust-lang.org/stable/clippy/lint_configuration.html#future-size-threshold)
for manual, assignment, and scheduler entry points; existing
real desktop scenarios cover the complete execution flow.
Long history hydration polls use `performanceSnapshot` with `collectMemory: false`
to avoid forced GC on every poll; final memory assertions retain full sampling.
Timeout diagnostics include the last snapshot. Permission modes use dedicated
Core shard 11, retaining real MCP deadlines within the serial Windows shard budget.
Source project configuration no longer forces the Windows unelevated sandbox,
which rejects split writable roots; other permission and approval settings remain.
Windows source-project coverage therefore verifies outside writes can execute;
other platforms retain OS write-denial checks. All platforms still verify explicitly
authorized writes, native approval denial of private reads, and no private data
disclosure. The network probe declares a text response type so PowerShell does not
enumerate response bytes.
The subscription model fixture rejects every upgrade path with HTTP 426 and
handles `ECONNRESET` throughout the socket lifetime; other socket errors still
fail. Node regressions cover different paths, repeated resets, and unexpected errors, preventing
an unhandled socket error from crashing cleanup after scenario assertions pass.

Long scenarios are split into independent checkpoints as well as balanced shards:

The newly merged `stand-in-project-enable` checkpoint has no historical sample.
It shares preparation with the stand-in configuration flows in Core shard 3,
which now contains 15 tasks; other ordinary Core shards contain 14. The estimates
above exclude this new checkpoint.

- `plugin-account-auth` expands into password sync, exclusive credential transfer, OAuth, DWS accounts, conversation QR, and GitHub checkpoints.
- `plugin-uninstall-resilience` expands into write coordination, lost response, unknown result, restart recovery, and reinstall race checkpoints. `plugin-write-coordination` independently checks API responsiveness during contention, post-commit ACK conflicts, and later sync recovery. Removal recovery checkpoints create another active installation so catalog refresh is tested alongside pending cleanup.
- `harness-apps` expands into development and installation/runtime lifecycle checkpoints.
- `streaming-text` expands into content, tool details, timers, scrolling, message order, and subagent checkpoints.

Each checkpoint establishes its own prerequisites in an isolated environment. The
group names remain valid for `--segment`; `--from-segment` starts at the group's
first checkpoint. CI schedules the individual checkpoints directly. Shards reuse
the same build artifact while reducing CPU contention between heavy workflows.
The long list still checks all 24 plugins, scrolling, and last-item selection.
`plugin-toggle-persistence` independently checks enable/disable persistence across
two restarts with one plugin, avoiding repeated synchronization of the whole list.
Linux Core/Cloud tests emit `[runner-resources]` JSON records at startup, completion,
and every 15 seconds, also saved as `runner-resources.jsonl` in the diagnostic
artifact. Web shards reuse this sampler with `RUNNER_PROCESS_DIAGNOSTICS=1` to
record process IDs, parent IDs, states, elapsed times, and names without command
arguments. `RUNNER_RESOURCE_LOG_PATH` selects the log path; separate
`e2e-process-diagnostics-*` artifacts help diagnose commands that remain alive
after tests finish. Records include CPU utilization, load average, memory, available disk
space, Linux CPU/memory/I/O pressure, and cgroup CPU limits, memory peaks, and OOM
counters. Unreadable kernel metrics report `unavailable`. CPU utilization is the
average between samples; its initial value is `null`.
`[desktop-e2e-schedule]` logs list active checkpoints and actual concurrency on
each start and completion, making overlap visible independently of the configured
worker limit. Compare shard durations and these metrics after increasing
concurrency to identify CPU, memory, or I/O contention.
Drawer animation checks sample from before the action until movement is observed
and the track animation completes, then stop explicitly within the shared step
timeout. Command transport and rendering delays cannot exhaust a fixed 800ms
capture window. Movement, continuity, intermediate-frame, and reduced-motion
assertions remain intact.
The 2,200-delta Codex notification
isolation stress case and the long plugin auto-update checkpoint each have a
dedicated shard; the notification scenario uses a targeted 30-second render
budget without changing the shared 10-second UI timeout. CI first builds one Core Electron
application, Executor, and Codex artifact. Electron package preparation builds
the Harness runtime, Node execution runtime, and Executor concurrently; the
Harness preparation owns the single DSH application Vite build so the same
frontend is not compiled twice. Every Core and Cloud shard downloads and reuses
that artifact instead of rebuilding Vite, Electron, and Executor. Desktop shards
start only after the shared build succeeds and download it directly through the
GitHub artifact action. This prevents many runners from sitting idle while
polling during the build, allowing Lint, Tests, and Platform E2E to acquire
runners promptly without adding matrix jobs or dropping checkpoints.
Both the Rust gateway and Executor use debug profiles so E2E does not spend time
on unused release optimization. Test artifacts also disable dev-profile
debuginfo because diagnostics do not retain those symbols; generating and then
stripping them only extends a cold build. Rust builds
reuse both the `main`-owned Cargo target cache and sccache compiler units: the
target cache bounds PR and first-run latency, while sccache reduces incremental
compilation after dependency or source changes. Archiving strips Linux debug symbols only from the copied
artifact binaries, leaving the original build outputs unchanged while reducing
upload and download time across the shards. Source changes under `backend-rs/**`
or `executor/**` select the desktop target-cache warmup so `main` does not refresh
that cache only when a lockfile changes. Desktop E2E and its cache
warmup explicitly set `WEWORK_EXECUTOR_PROFILE=debug` so test artifacts do not
spend time optimizing the Executor. Release packaging leaves the variable unset
and continues to build the `release` Executor by default. Desktop E2E builds
skip the duplicate TypeScript typecheck that the parallel Lint workflow runs in full,
while retaining the real Vite and Electron artifact build; test coverage and the
type gate remain unchanged. The shared macOS Inspector and memory E2E build uses
a release Executor so memory measurements use optimized code. The macOS memory job keys its pnpm store from both
the workspace and Electron lockfiles, then installs offline so registry stalls
cannot consume the critical-path budget. Its large streaming Markdown response
uses a targeted 30-second completion budget while ordinary memory interactions
retain the shared 10-second timeout. The plugin suite requires an independent build
configuration and continues to run in parallel with the shared Core build.
Desktop shards use only the runtime tools already present in the immutable E2E
image; ZIP fixtures use Python's standard library, so the jobs do not restore
the full frontend dependency cache. Successful harness-app coverage keeps
milestone screenshots, and every run retains logs, state snapshots, and other
useful diagnostics. Before upload, CI removes only transient Chromium caches
that cannot help reproduce a failure. Uploads disable redundant compression for
PNG and other already-compressed evidence so artifact archiving does not extend
the pipeline tail. Merge queue validates
the final commit that enters `main`, so Tests, Lint, Platform E2E, and Wework E2E
do not repeat the same validation after the merge through a `push main` trigger. The
mapping lives in `.github/scripts/classify-wework-desktop-e2e.sh` and must be updated when new
feature coverage is registered. When adding a `DESKTOP_CHECKPOINTS` entry, also
add it to a Core, Cloud, or formal-release catalog, assign it to a shard, map
the relevant source paths to the smallest applicable coverage, and update both
the matrix expectations and focused classifier assertions in
`.github/scripts/test-classify-ci-changes.sh`. The classifier rejects a
checkpoint that exists only in the runner without CI catalog coverage, preventing
locally runnable coverage that GitHub CI never invokes. Segment commands are also
useful for focused local iteration:

```bash
pnpm --filter wework e2e:desktop -- --segment automation-lifecycle
pnpm --filter wework e2e:desktop -- --segment local-harness
pnpm --filter wework e2e:desktop -- --segment model-routing
pnpm --filter wework e2e:desktop -- --segment window-lifecycle
pnpm --filter wework e2e:desktop -- --from-segment window-lifecycle
pnpm --filter wework e2e:desktop -- --segment temporary-chat
pnpm --filter wework e2e:desktop -- --segment workspace-attachments
pnpm --filter wework e2e:desktop -- --segment claude-runtime
```

`automation-lifecycle` independently covers automation creation, immediate
execution, pinning and continuing an existing task, and scheduled continuation.
`model-routing` independently covers all six local protocol-switch directions,
cross-provider retry, the vision sidecar, and the local model protocol matrix.
Both checkpoints establish their own minimal fixtures, so they no longer extend
the critical path for task creation, follow-up, and background plans in
`core-task-flow`. An unsegmented complete desktop run still executes these
scenarios, so splitting them does not reduce coverage.

`temporary-chat` creates an independent local project and real Codex ephemeral
thread, holds a follow-up response open, verifies that the user message appears
above the Thinking indicator, and confirms that the temporary-chat content is
restored from the runtime conversation cache after switching the main
conversation away and back.

`claude-runtime` uses the real Electron Wework application, Backend, local
executor, and remote executor to verify Claude Code creation, follow-up, and
cancellation on both local and remote devices. It also confirms that remote
execution uses the target device's own Claude Code binary and checks visible
DOM state so the sidebar and composer stop showing running after completion;
the hidden sidebar preview retained by the layout is excluded from visible
state assertions.

`local-harness` uses the real OpenCode, Claude Code, and Kimi Code CLIs pinned
by `.github/claude-code-cli/package-lock.json`; argument-recording shell
fixtures are not valid substitutes. The scenario must assert real requests
from every CLI through the Wework local model proxy. Kimi Code starts as an
interactive TUI, so its first prompt is injected only after PTY output contains
the readiness marker. Writing during terminal capability negotiation loses the
input.

The plugin desktop suite reuses the same segment options while keeping its
separate Codex Home initialization environment. Its ordered segments are
`plugin-lifecycle`, `skill-mention-rendering`, and
`sites-plugin-auto-install`. Each segment establishes the minimal plugin
fixture it needs, so it can run alone or continue through the later plugin
features. `plugin-lifecycle` also covers: the composer plugin picker no longer
listing a plugin after uninstall, and unmatched assistant `need_login` /
`connector_auth_required` resume text not opening a local auth card.

```bash
pnpm --filter wework e2e:desktop:plugins -- --segment skill-mention-rendering
pnpm --filter wework e2e:desktop:plugins -- --from-segment skill-mention-rendering
```

Ordinary desktop-runner UI steps time out after 10 seconds by default, so one
failed step does not always wait for the former 120-second limit. Control
commands and wait helpers accept `timeoutMs` for genuinely slower special
steps; startup, workbench recovery, and the model protocol matrix keep their
dedicated limits. Set `WEWORK_E2E_STEP_TIMEOUT_MS` to temporarily adjust the
global default for ordinary steps in a slower diagnostic environment.

Role settings load asynchronously, so source management uses `clickWhenEnabled` before clicking its entry. Catalog saves and restores first use the shared `waitForCatalogRestart` to handle the actual confirmation and verify that a new Codex process serves the catalog after persistence, then assert that the editor closes. A successful IPC request alone does not prove restart completion. These regressions retain the 10-second budget without reruns or expanded timeouts.

The main desktop flow also covers pasting or dropping ordinary files and folders from Finder. The composer must render file and folder path chips without creating an attachment badge. The request sent to Codex must contain the matching absolute paths without inlining file contents. This decision depends on whether the native desktop transfer resolves a file path; the composer must not switch to attachment upload early only because its current workspace is marked as remote. The top quick-send window uses the same rule and reads bytes only for image attachments. Both scenarios use ordinary small files. For focused local diagnosis, run `node wework/e2e/desktop/run-checkpoints.mjs --pasted-workspace-paths-only` or `node wework/e2e/desktop/run-checkpoints.mjs --dropped-workspace-paths-only`.

Following the cc-switch conversion boundary, the mock strictly validates what reaches the model side: authentication, model ID, stream settings, message history, tool choice, shell tools, and either the `apply_patch` Lark grammar or its function wrapper. Any incorrect field returns a non-2xx response and fails the test. The desktop test stores a follow-up screenshot for each interface plus the complete `model-requests.json`; GitHub Actions uploads desktop diagnostics on both success and failure.

The environment needs Rust, Electron build dependencies, and a real Codex binary. The runner finds `codex` on `PATH` by default; an installed or `prepare:codex`-prepared real binary can also be selected explicitly:

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

When binaries are not configured, the desktop runner first runs
`ai:verify:electron:build`, validates the packaged real Electron application and
its bundled Executor, and then starts the selected scenario. Optional
`WEWORK_E2E_EXECUTOR_BIN` and `WEWORK_E2E_APP_BIN` must be set together to reuse
already-built real binaries. A supplied application must be built with the
desktop E2E Vite environment variables. The lifecycle scenarios share one
application launch to control CI duration. Test artifacts, captured model
requests, and failure diagnostics are stored in
`wework/test-results/desktop-e2e/`. Each scenario retains logs, screenshots,
requests, and UI state while removing copied application bundles, Executor
homes, workspace fixtures, test archives, extracted runtimes, and every other
rebuildable top-level test environment. `electron-user-data` retains diagnostic
state only: materialized `managed-components`, `managed-runtimes`, DSH and
Harness profiles, and Electron caches are recursively removed from both the
main instance and nested plugin-development instances. The runner also compacts
inactive result directories left by interrupted runs so repeated local
execution does not continuously consume disk space.

The Linux CI plugin-development shard starts Electron-managed Executor processes
under GDB and records all thread stacks on native crashes. A startup check verifies
that the IPC file descriptor reaches the debugged process. Standalone MCP and schema
queries retain their stdout protocol. Stack diagnostics omit arguments and locals.
Desktop E2E Electron logs also retain redacted renderer errors. Git worktree and
conversation-index replacement failures record Git stderr or the original OS error
code to distinguish page timeouts from failures in the underlying execution.
Windows plugin installation diagnostics also record application asset directory
state, link targets, and file counts before and after pnpm operations. Static asset
read failures record the parent directory's link state to locate missing resources.
Windows component compositions and managed plugin packages own independent resource
files so pnpm cleanup cannot traverse directory links into shared components. Layout
fingerprints and copy-version stamps rebuild older layouts. Plugin-development E2E
checks that starting the isolated window preserves main-application assets and that
Windows package asset directories do not link to shared components.
Windows worktree commands set `GIT_COMMON_DIR` from the existing `.git` and
`commondir` parser so checkout children find shared objects before loading repository config.
Paths passed to Git omit the Windows verbatim prefix, allowing its slash-separated
`/config` suffix to be normalized by the Windows path layer.
Worktree removal, restoration, and snapshot-ref cleanup use `--git-dir .` inside
the common Git directory, avoiding Git's explicit-directory length rejection before
configuration loads. Worktree target paths remain absolute.
Windows conversation indexes use POSIX replacement semantics with `FileRenameInfoEx`:
existing readers retain the complete old index, and new readers see the newly published index.
The destination parent is canonicalized to retain the long-path prefix for the direct
Win32 call, including initial index creation.
Native CI covers repeated replacements with open readers and replacements beyond `MAX_PATH`.

Plugin cache mutations restart the Codex app-server, so synchronization waits for both
AI tasks and background terminals to finish. Regression coverage verifies deferred updates
while a process runs and publication after its native exit notification. Desktop coverage
retains output-reading and process-stopping assertions after a window reload.
Windows fixtures use cross-shell terminal commands and verify a completed output line;
settings controls are scrolled into view. Git fixtures disable automatic line-ending
conversion, and queue/sidebar fixtures explicitly select the test model without weakening
behavioral assertions. CI verifies the development Electron binary during setup so its
first import does not download it inside a scenario.

Remote collaboration initializes the execution environment catalog through the real
Backend and verifies authorization for the remote device before opening the Agent form.
Native model catalog initialization does not consume the form's 10-second UI step budget.
On desktop startup failures, `scenario-state.json` records application launch and exit
times and exit codes. Windows also retains `electron.log` to diagnose native failures
before the renderer connects.
Migration fixtures isolate workbench data through `HOME` and preserve the operating
system's `USERPROFILE`. The controller acknowledges each action before polling for
the next command, keeping pending long polls out of the result acknowledgement path.
System proxy scenarios and the initial task-status synchronization request use the
model-stage budget for model requests and retain 10-second ordinary UI steps.
Initial tasks and follow-up messages reuse `sendPromptUntilScenarioRequest`,
registering request listeners before sending with the shared 30-second model-request limit.
Background guidance uses the same model-stage budget for real tool output and subsequent model
requests. A native tool can yield a still-running session after ten seconds; this tool phase
must not use the ordinary UI-step limit.
The message-order scenario waits for the current turn's SSE response to finish sending with the model-stage budget, then uses the unchanged ten-second UI budget for its message content. The recorded response number must match the current turn. HTTP diagnostics retain request start, finish, and duration so Codex execution delays are not mistaken for missing virtual rows.
The stream-recovery scenario selects its registered fixture model before the first send;
the composer appearing does not establish model-catalog readiness. It still verifies that
streaming continues during renderer reload and restores the complete output.
The shared Enter-send helper and model matrix reuse the same send-control readiness check.
After filling a draft, wait for the control to become enabled with the original ten-second step
budget, then send Enter once. An available editor or stable composer text does not establish
restored model-catalog readiness after reload. The model request and
send action are awaited together so either failure follows the normal diagnostics and cleanup
path instead of an unhandled Promise rejection exiting Node without a failure snapshot.
Model-request waits stop polling when their budget expires, leaving no active poll timers.
The ordinary send-control wait retains the 10-second step limit.
Restoring native model-catalog defaults temporarily unmounts model rows while refreshing.
The scenario observes the stable page until the original row returns without its customization
marker, then verifies native data and the persisted override file.
The overload cancellation phase selects its fixture model independently for the new conversation.
When a user resumes and completes a Goal during overload backoff, the executor processes queued new-turn events before applying the latest Goal snapshot. A new turn still running must deliver its own terminal event. Focused regressions cover completed, in-flight, paused, and cleared Goals, preserving the current turn identity without an extra Goal activation or turn start. Fake app-server processes use independent temporary Homes so concurrent skill configuration reloads cannot send requests to another test’s process.
The device artifact declaration scenario uses one Node invocation to generate its file and execute the real declaration command, avoiding Unix heredoc syntax in Windows PowerShell. Only a successful declaration emits its completion marker, which the model must receive before finishing. Unique-artifact, exact-content download, and native-preview assertions remain enabled. Local command verification covers PowerShell, Unix shells, spaces and Unicode in paths, and declaration failure propagation.
In run 40623393090, every Windows Core 4 checkpoint passed, but startup and cleanup exhausted the 40-minute step limit. Move the measured six-minute board sorting checkpoint to the existing roughly 22-minute Core 8 shard. Retain the runner count, every checkpoint, the 40-minute limit, and exclusive latency benchmark and permission shards.
The stand-in settings scenario uses the existing `clickWhenEnabled` action to wait for its sidebar entry after switching collaboration tabs or reloading. A visible tab does not establish that its asynchronous page has mounted.
Action execution and result acknowledgement are separate: an acknowledgement failure must not
produce a fabricated failed-action result. E2E Electron logs retain loopback request paths and
network error codes without headers or query parameters. Windows failure artifacts include
`windows-network-diagnostics.json` with TCP state and process connection counts, excluding addresses,
to diagnose Winsock resource exhaustion.
Task-board bulk actions confirm that the blank conversation is active before each input;
the editor node alone is insufficient. Goal restart fixtures observe one running task and
one queued task before releasing the model response occupying the single execution slot.
Work-list refreshes preserve the device owning an opened workspace so an earlier response
cannot replace a newly selected cloud workspace.
Workbench and conversation diagnostics share a 100ms publication scheduler. Continuous state updates must not cancel a pending publication, and each publication reads the latest state. Disabling diagnostics or unmounting cancels pending work so an inactive pane cannot overwrite the current snapshot. A failed conversation-title isolation assertion retains its assistant-count baseline and the title, lifecycle, and message summary from each poll.
Manual conversation renames emit the existing `runtime.task.title.updated` event after persistence so other workbench consumers immediately receive the private title. Terminal history diagnostics record keyboard and actual viewport metadata without terminal contents. Native input waits for a trusted keyboard event at the exact target and a successful host response, rather than fixed 16ms settling timers. Missing events retain the 10-second step budget, and listeners are removed on success or failure. For native CPU traces, point `WEWORK_E2E_RENDERER_CPU_PROFILE_DIRECTORY` to an absolute directory. Isolated E2E saves `renderer-*.trace.json` every 20 seconds to identify renderer long tasks.
Diagnostics record project-selection
reducer actions and IDs, draft scopes and parent acknowledgement revisions, Codex app-server
process IDs and initialization exit states, and failed Windows process-tree termination states.
Configuration normalization and replacement record file size and the presence of model and built-in OpenAI URL fields; replacements also record their call site, without configuration contents.
Only a missing configuration file permits empty initialization; other read failures stop startup and preserve the existing file. A regression uses invalid UTF-8 to trigger a real read error and verifies that the original bytes remain unchanged, preventing normalization from silently clearing model addresses.
`codex-invalid-launch-cwd` records isolated configuration fingerprints and fixture-field matches before launch, around executor restart, and before sending. It also reads native configuration-layer sources and field presence to distinguish disk changes from runtime loading failures.
Codex app-server restarts and configuration changes hold the admission lock until the old process exits before admitting a new process.
Failure artifacts include `codex-sqlite-diagnostics.json` with isolated database file sizes,
read-only integrity results, and SQLite error codes; conversation tables are never queried.
Failed executor compatibility queries record elapsed time, exit code, signal and termination status
without child output, command paths or environment variables.
Desktop fixtures bind the workspace root to their temporary Home and remove other inherited
workspace path overrides, avoiding stale test or personal worktrees. Turn preparation failures
record their error code and reason instead of leaving only a UI timeout.

Executor configures loopback `NO_PROXY` before creating the Tokio runtime, avoiding
process environment mutation on asynchronous connection threads. The startup scenario
verifies that Executor becomes ready before Core DSH starts and that DSH binds a valid port.
The blocked-proxy startup scenario verifies that the workbench starts without waiting
for Codex network access, then releases the proxy and waits for local plugin registration
before clearing the proxy setting, avoiding cancellation of in-flight initialization.

Core DSH binds port `0` directly and lets the OS assign its listening port.
Electron reads the actual DSH address before probing the host, Executor, Terminal,
and application endpoints. It does not discover a port by opening and closing a
temporary listener, avoiding collisions during concurrent startup.

Linux cloud-test services, including backends and databases, publish ports before
startup. The shared allocator reads `/proc/sys/net/ipv4/ip_local_port_range` and
selects bindable, unprivileged ports outside that kernel dynamic range. The port
registry keeps parallel checkpoints separate, while excluding the dynamic range
prevents Core DSH and other port `0` listeners from claiming ports during service
initialization.

Before upload, GitHub Actions repeats the cleanup and excludes
`managed-components` at any depth from the Artifact path so a teardown failure
cannot upload the complete Web and WASM component payload from either the main
instance or a nested plugin-development instance as diagnostic evidence. Both
the top-level cleanup and Artifact paths also exclude test `.zip` archives.
Diagnostic Artifacts use standard compression and should normally remain below
20 MiB. They should contain logs, screenshots, requests, UI state, and necessary
Electron persistence only, never rebuildable applications, runtimes, Executor
homes, workspaces, test archives, or component directories.

The local runner writes complete stdout and stderr from the prerequisite
Electron and Executor build to
`wework/test-results/desktop-e2e/desktop-build-<pid>.log`. The terminal shows
only the build stage, a liveness message every 30 seconds, elapsed time, and the
log path so package installation, compilation, and signing output do not bury
checkpoint results. On build failure, the terminal also prints a bounded tail
of the log. Test output remains live after the scenario starts.

`ai:verify:electron:build` shares immutable Harness Runtime archives across worktrees. The default archive cache is `~/Library/Caches/wegent/harness-runtime` on macOS, `${XDG_CACHE_HOME:-~/.cache}/wegent/harness-runtime` on Linux, and `%LOCALAPPDATA%\wegent/harness-runtime` on Windows. Materialized development runtimes remain under `wework/node_modules/.cache/harness-runtime-dev` in the current worktree so mutable state is not shared across source trees. Set `WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT` to override the archive cache. If a build only sets the legacy `WEWORK_HARNESS_RUNTIME_CACHE_ROOT`, that value is translated into an archive-only cache override and does not move the current worktree's materialized runtime.

Before launching Electron, desktop E2E removes inherited task, IPC, Node, and Harness runtime variables so a development Wework or Codex session cannot leak personal runtime paths into the test application. To select a Core DSH runtime explicitly for focused diagnosis, set `WEWORK_E2E_HARNESS_RUNTIME_ROOT`; the runner validates that directory and passes it to the test application as `WEWORK_HARNESS_RUNTIME_ROOT`. Do not pass `WEWORK_HARNESS_RUNTIME_ROOT` directly to the test command.

On macOS, desktop E2E injects the test-only `WEWORK_E2E_BACKGROUND_WINDOW=1` setting by default. It keeps the Electron main window hidden, prohibits application activation, and hides its Dock icon. Background throttling is disabled for the hidden WebView, so DOM control, timers, and snapshots continue to work. Set `WEWORK_E2E_BACKGROUND_WINDOW=0` explicitly when foreground window inspection is required. This setting affects desktop E2E only; normal development and production launches are unchanged.

The cloud-project scenario starts a real Backend, Redis, and a real Executor registered as a remote device. It exercises real authentication, device RPC, task persistence, and project deletion while covering project creation, task execution, conversation restoration, follow-up, and project removal. The scenario also verifies all three model protocols through the Backend proxy for cloud Model CRDs, plus local-executor use of Codex and cloud models under the same connected account. Only provider model endpoints are simulated; Backend HTTP and WebSocket APIs must not be mocked. To shorten cold startup, the Executor build runs in parallel with Backend, Redis, and database preparation, while remote Executor registration runs in parallel with the Electron application build. Application startup still waits for both prerequisite groups to finish. Project cleanup must wait until the task is no longer running; rendered assistant text does not mean the final task state has been persisted. Python 3.11, `uv`, and `redis-server` are required to run this scenario.

The hybrid Backend launcher gives Python Uvicorn a 2,400-second upstream HTTP
keep-alive, longer than the workflow's longest 35-minute hybrid E2E job.
`brz-http-gateway` 0.1.4 builds a hyper-util connection pool without installing
its idle-connection timer. If Uvicorn expires an idle socket first, the gateway
can reuse that upstream-closed connection and incorrectly return `502 fallback
upstream unavailable`. Bounding the upstream lifetime beyond the job prevents
that stale-socket window in this local hybrid launcher. The setting affects only
the local Rust-to-Python fallback connection and does not disable keep-alive
between external clients and the gateway.

Before validating local-executor models for a connected account, the cloud scenario selects its isolated directory through the current Projects → Local project entrypoint and confirms the name in the local-project creation dialog. Desktop E2E coverage must follow this primary product flow instead of relying on the removed existing-project test entrypoint.

The `plugin-account-auth` scenario uses shorter scheduling intervals only when
an E2E reconciliation marker is configured and emits one precise retry signal
after the test changes credential state. Production retains the 15-second
automatic synchronization period and 60-second failure backoff. The DWS manual
revocation assertion no longer sleeps for a fixed 32 seconds. It waits for two
completed reconciliation markers from the real Executor while continuously
asserting that the grant remains revoked, so the optimization removes idle time
without dropping account migration, cloud execution, or revocation coverage.

The GitHub Actions Executor E2E job loads a prebuilt Docker image after restoring Python, Node.js, and Playwright caches. It must first remove unused hosted-runner SDKs (.NET, Android, GHC, and CodeQL) and print disk usage so image extraction has stable headroom. The cleanup must not remove the running MySQL or Redis service images.

The plugin scenario dynamically creates an isolated local Codex marketplace and a plugin with a Skill under the test-results directory. It then uses the real Electron renderer, Executor, and Codex app-server to verify marketplace discovery, installation, the install-time local authorization dialog, insertion of the plugin reference into the chat composer, unmatched resume auth text not opening a local auth card, composer filtering after uninstall, and uninstallation. It neither reads the user's Codex home nor mocks plugin APIs; marketplace data, plugin cache, and installation state remain inside the isolated test directory. Screenshots are retained for the critical stages, with application, Executor, and UI snapshot diagnostics retained on failure.

The memory scenario is macOS-only. It keeps the bottom Terminal mounted, executes a development task through a real Codex tool call, then streams a long response containing Markdown, tables, and TypeScript code into the real Electron renderer. The test first waits for the renderer-process memory baseline to stabilize, then samples the aggregate physical footprint of associated Electron renderer processes every 500 milliseconds. Each sample also forces renderer garbage collection through the Electron DevTools Protocol and reads actual JS heap usage. It writes the samples, DOM node counts, active-assistant content summary, and aggregate metrics to `memory-growth.json`; the gate does not include the main Wework process. The default gates limit physical-footprint peak growth to 384 MiB, settled growth after completion to 232 MiB, the full physical-footprint range within the settled window to 16 MiB, and the post-GC JS heap peak across the workload to 200 MiB. The DOM gate checks the settled window after virtual-list convergence and allows at most 576 additional nodes relative to baseline by default. Transient peaks during streaming remain in the diagnostics but do not treat pre-convergence rendering as a leak. The limits can be adjusted with `WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB`, `WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB`, `WEWORK_E2E_MEMORY_MAX_SETTLED_DOM_NODE_GROWTH`, and `WEWORK_E2E_MEMORY_MAX_JS_HEAP_BYTES`. For focused very-long-stream reproduction, use `WEWORK_E2E_MEMORY_SECTION_COUNT` and `WEWORK_E2E_MEMORY_CHUNK_DELAY_MS` to configure response sections and chunk delay. The completion budget remains fixed at 30 seconds and cannot be relaxed through an environment variable.

The concurrent-memory scenario is also macOS-only. It creates and holds 10 Responses streams at the same time, samples the process-group physical footprint for the Wework main process, Electron renderer/GPU/network processes, Executor processes, and the Codex app-server, and writes the evidence to `concurrent-memory.json`. Relative to the stable baseline, both the peak and active settled plateau may grow by at most 320 MiB, while the settled sampling window may vary by at most 64 MiB. The limits can be adjusted with `WEWORK_E2E_CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB`, `WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB`, and `WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB`. The scenario also switches between the first and last tasks and waits for each task's prompt content to reappear.

## Responses API Mock

`wework/e2e/utils/mock-response-api-server.mjs` provides a real HTTP service that validates local-model capability probes:

- `POST /v1/responses`: returns non-streaming Responses API JSON.
- `POST /v1/responses` capability probes: returns `text/event-stream` tool-call events such as `response.output_item.added` and `response.output_item.done`.
- `POST /v1/responses` with `stream: true`: returns `text/event-stream` events including `response.created`, `response.output_text.delta`, and `response.completed`.
- `POST /v1/chat/completions`: validates and returns a Chat Completions function tool call.
- `POST /v1/messages`: validates and returns an Anthropic Messages `tool_use` block.
- `GET /captured-requests`: reads captured requests.
- `POST /clear-requests`: clears captured requests.
- `GET /health`: CI health check.

The mock enables CORS, so the Wework page can call it with a real browser `fetch`. For model connection tests, use this base URL:

```text
http://127.0.0.1:9998/v1
```

## External Upstream Mocks

Wework E2E also starts two local loopback upstream mocks. They replace only services outside Wegent; they do not replace Wegent Backend, Executor, Codex, `/api/sites`, `/api/apps/installed`, or connector runtime APIs.

`wework/e2e/utils/mock-sites-upstream-server.mjs` simulates the Sites project API and returns Sites or Mini Programs according to `app_type`:

- `GET /api/v1/projects/search`: returns deterministic projects and supports `username`, `limit`, `sitename`, and `cursor`.
- `POST /api/v1/projects/deploy/network`: updates project network visibility.
- `POST /api/v1/projects/update`: updates project name.
- `POST /api/v1/projects/del`: deletes a project.
- `GET /captured-requests`, `POST /clear-requests`, `POST /reset`, `GET /health`: assertion and reset helpers.

To cover the Sites path through a real Backend, start Backend with the following environment variables. These variables must be passed to the Backend process; passing them to Vite or the Playwright page does not configure Backend.

```text
SITES_API_BASE_URL=http://127.0.0.1:9997
SITES_API_TOKEN=e2e-sites-token
```

Example:

```bash
cd backend
SITES_API_BASE_URL=http://127.0.0.1:9997 \
SITES_API_TOKEN=e2e-sites-token \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`wework/e2e/utils/mock-connector-upstream-server.mjs` simulates external services that connector apps can target:

- `GET /api/tickets/{id}`: acts as an HTTP connector upstream.
- `POST /mcp`: provides minimal Streamable HTTP MCP JSON-RPC behavior for `initialize`, `tools/list`, and `tools/call`.
- `GET /captured-requests`, `POST /clear-requests`, `GET /health`: assertion and reset helpers.

Connector app test data can use:

```text
HTTP connector base URL: http://127.0.0.1:9996/api
MCP URL: http://127.0.0.1:9996/mcp
```

An HTTP connector fixture can use:

```json
{
  "slug": "ticket-http",
  "name": "Ticket HTTP API",
  "description": "E2E HTTP connector upstream",
  "enabled": true,
  "visibility": "all",
  "allowed_roles": [],
  "auth_type": "none",
  "transport": "http",
  "mcp_url": "http://127.0.0.1:9996/api",
  "oauth_scopes": [],
  "provider_headers": {},
  "tool_allowlist": ["get_ticket"],
  "http_tools": [
    {
      "name": "get_ticket",
      "description": "Get one mock ticket",
      "method": "GET",
      "path": "/tickets/{id}",
      "input_schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "expand": { "type": "boolean" }
        },
        "required": ["id"]
      },
      "argument_locations": {
        "id": "path",
        "expand": "query"
      }
    }
  ]
}
```

An MCP connector fixture can use:

```json
{
  "slug": "docs-mcp",
  "name": "Docs MCP",
  "description": "E2E Streamable HTTP MCP connector upstream",
  "enabled": true,
  "visibility": "all",
  "allowed_roles": [],
  "auth_type": "none",
  "transport": "streamable-http",
  "mcp_url": "http://127.0.0.1:9996/mcp",
  "oauth_scopes": [],
  "provider_headers": {},
  "tool_allowlist": ["search_docs"]
}
```

## Automation Bridge

In test mode, Wework exposes a frontend control bridge at `window.__WEWORK_E2E__`. The bridge is installed only when `import.meta.env.MODE === "e2e"` or `VITE_WEWORK_E2E=true`; normal development and production runs do not enable it by default.

Isolated real Electron verification can dispatch path paste or drop events to the composer with `ai:verify paste-paths` or `ai:verify drop-paths`. The `--value` argument accepts a JSON array whose entries contain `uri` and `name`; folder entries also set `isDirectory: true`:

```bash
pnpm --filter wework ai:verify paste-paths \
  --session /absolute/path/to/session.json \
  --selector '[data-testid="chat-message-input"]' \
  --value '[{"uri":"file:///tmp/context","name":"context","isDirectory":true}]'
```

Replace `paste-paths` with `drop-paths` in the example to verify Finder drag and drop.

Available methods:

- `isDesktop()`: returns whether the app is running in Electron.
- `getRuntimeConfig()`: reads the current runtime config.
- `getRoute()`: returns the current route with the app base path removed.
- `navigate(path)`: changes route through frontend history and dispatches navigation events.
- `waitForTestId(testId, options)`: waits for a `data-testid` to appear.
- `queryTestIds(prefix)`: lists current `data-testid` values, optionally filtered by prefix.
- `setAuthToken(token)`: stores a real auth token.
- `clearAuthToken()`: clears the auth token.
- `clearStorage()`: clears local auth state and browser storage.

The desktop E2E build additionally injects `VITE_WEWORK_DESKTOP_E2E_CONTROL_URL`. Only when E2E mode and this URL are both present does the frontend poll a local loopback controller for `click`, `fill`, and wait assertions; normal development and production builds have no controller endpoint. The controller drives real WebView DOM events and does not replace task, model-selection, Executor, or Codex implementations.

When a built-in action does not handle a command, the public controller delegates it through `@extensions/desktop-control` to a product extension. Without a product extension, unknown actions fail explicitly; public automation does not recognize concrete product protocols.

The controller uses short polling: the server returns `204` when no command is available, and the frontend waits briefly before polling again. This prevents a stale long-poll connection, left behind by a WebView reload, task switch, or stream completion, from consuming later commands. When `fill` targets a Lexical editor, the controller uses the editor's exposed `value` setter so the React/Lexical state is actually committed; do not replace it with raw DOM insertion. Failure diagnostics include delivered `commandHistory` in `scenario-state.json` to aid control-channel debugging.

The desktop controller uses Electron `webContents.capturePage()` for native renderer screenshots. The capability is available only when `VITE_WEWORK_E2E=true`; selector captures crop the native image by the element bounds, so diagnostics preserve the actual Electron rendering.

Switching models in the same conversation can cause Codex to issue an internal context-compaction request. The desktop task-flow E2E loopback Responses service identifies and responds to these requests through `client_metadata.x-codex-turn-metadata.request_kind === "compaction"`, so they are not mistaken for a user follow-up message.

## Test Helper

`wework/e2e/fixtures/wework-app.ts` provides a `WeworkApp` Playwright helper that wraps `window.__WEWORK_E2E__` in typed test operations:

```ts
const app = new WeworkApp(page);

await app.goto("/");
await app.waitForTestId("login-form");
await app.navigate("/apps");
const route = await app.route();
```

New E2E tests should prefer this helper and `data-testid` locators instead of unstable CSS selectors or visible copy.

## CI Guidance

The Backend Rust E2E image contains both `wegent-backend-rs` and `attachment-s3-e2e`. Its producer, desktop consumers, and warmup use the shared `v2` image naming rule in `resolve-backend-rs-e2e-runtime.sh`. Their identical hash inputs include the Rust manifest, lockfile, sources, examples, and `.github/runtime-images/backend-rs-e2e.Dockerfile`. Recipe changes generate a new tag; old `v1` images containing only the API server cannot be reused. Cache hits must still restore the complete payload. CI invokes runtime handoff unit tests that verify matching build, publication, restoration, and upload paths instead of skipping missing files or hiding cache defects behind a fallback.

The platform E2E base image, `docker/wework-e2e/browser.Dockerfile`, preinstalls the Docker CLI through `docker.io` and checks `docker --version` during its build. Shards use that CLI when preparing the remote workspace Executor without running apt update or installation. The Dockerfile content hash determines the image tag, so CI builds a new image after changes and reuses it in subsequent runs.

Local list bootstrap reads and manual refreshes share one revision. A superseded bootstrap read must exit before both publishing its list and starting cloud synchronization, preventing stale startup work from restarting synchronization and clearing a selected local project. The original task-discovery E2E keeps its execution-mode and local execution assertions unchanged.

Cloud Issue change notifications must invalidate an in-flight older board snapshot and start a read after the notification. Use the shared controller’s `loadProjectSnapshot(projectId, { invalidate: true })` to reuse its mutation-generation protection. This prevents a reassignment notification from sharing an older read triggered by unassignment. Ordinary duplicate reads remain coalesced. Frontend CI runs the controller concurrency regression; the original human Issue E2E retains its 10-second UI wait.

Platform E2E services must start etcd and MinIO before Milvus. The GitHub runner pulls and starts containers sequentially in configuration order. Placing MinIO after Milvus can leave its DNS name unavailable during Milvus initialization while later images are being pulled. Health checks run after all containers have started and cannot repair this startup ordering.

Desktop E2E `clickWhenEnabled` starts the existing ten-second conversation layout diagnostic window. Milestone and failure artifacts retain `conversation-diagnostics` JSON with virtual ranges, message measurements, and scroll positions. These records contain no message text and do not change UI waits or business assertions. Compare them with `workbench-debug.json` when a completed message is missing from the rendered conversation.

On Windows, a worktree's `.git` file can have the hidden attribute, causing Node's default `writeFile` mode to return `EPERM`. The archived-cleanup fixture opens the existing file with `r+`, explicitly truncates and writes it, and closes the handle in `finally`. Corruption, restoration, and failure cleanup share this implementation.

For consecutive sends, compare request counts with composer diagnostics: a previous send resolving asynchronously must not clear a subsequently written draft. The pane uses an input-write version to constrain submission cleanup. Once the composer clears or the user writes the next draft, the old submission no longer owns that draft. Unit tests interleaving asynchronous acceptance and new draft writes must cover both ordinary messages and messages with code comments.

The desktop control channel registers after model fixtures finish seeding, retaining diagnostic access if seeding fails. Workbench Home migration probes use `ensureLocalModelCatalogReady` to await model-catalog synchronization and its app-server restart before accessing the migrated Home with native Codex. Executor startup alone does not establish catalog readiness. A failed native probe retains `native-migration-turn-failure.json` with the actual Home, database integrity, and thread history mode. Check initialization warnings first: a log-database open failure can surface as a `list_turns` error without losing thread history.

Opening project settings waits for and clicks the current project's edit or rename action directly. The sidebar chooses its menu identifier from the project's state owner and source; a snapshot taken before the menu renders cannot determine that action. Cloud project save, restart, and restored-settings assertions remain unchanged.

During local macOS verification of cloud project state files, a running ChatGPT or Codex desktop application activates the existing state-write guard. A runner whose HOME and Codex Home are both inside its isolated test-result directory can use `WEGENT_FORCE_CODEX_GLOBAL_STATE_OPLOG_FLUSH=1` to verify that state reaches disk.

CI can run Wework E2E as a separate job:

```bash
pnpm install --frozen-lockfile
pnpm --filter wework exec playwright install chromium
pnpm --filter wework e2e
```

Desktop task-flow E2E requires a Linux runner with a graphical session, for example:

```bash
pnpm --filter wework prepare:codex
xvfb-run -a pnpm --filter wework e2e:desktop:plugins
xvfb-run -a pnpm --filter wework e2e:desktop
xvfb-run -a pnpm --filter wework e2e:desktop:cloud
```

GitHub Actions runs the plugins, core, and cloud Linux desktop scenarios as a
parallel matrix. Each scenario receives an isolated runner, HOME, Executor
Home, ports, and diagnostic artifact. This preserves the existing real Electron,
Executor, and Codex verification semantics while removing the serial wait
between the three scenarios. Matrix fail-fast is disabled so the remaining
scenarios can finish and upload diagnostics when one scenario fails.
The three scenarios reuse one prebuilt Electron artifact. Scenario-specific
values such as Codex Home initialization, cloud endpoints, and test credentials
are injected through the desktop E2E runtime config when Electron starts rather
than compiled into the application binary. Plugins, core, and cloud can therefore
share the application build while retaining isolated runtime directories and
process state.

The Linux desktop scenarios cache the downloaded `.deb` files for Electron system
dependencies in the runner user's home directory. Cache keys rotate weekly and
are scoped by operating system and CPU architecture. Every run still executes
`apt-get update`; an older cache is only a restore source, and missing or
updated packages are downloaded from the Ubuntu repositories. Installation
uses `--no-install-recommends` plus repository retries and timeouts to reduce
whole-job timeouts caused by transient hosted-runner mirror degradation.

The memory gate depends on macOS Electron process association and physical-footprint sampling, so run it separately on a macOS runner:

```bash
pnpm --filter wework prepare:codex
pnpm --filter wework e2e:desktop:memory
```

The repository includes a basic workflow at `.github/workflows/wework-e2e.yml`. It runs when Wework, `packages/chat-core`, the pnpm lockfile, or the workflow itself changes.
Linux and Windows Desktop Core E2E consume the same shard matrix produced by
the classifier; a complete classification runs every declared Core shard on both
platforms. The Windows job builds native `WeWork.exe`,
`wegent-executor.exe`, and `codex.exe` artifacts on `windows-latest` before
running checkpoints. A cross-platform package or a single Windows smoke test is
not equivalent coverage.

Regular draft PRs do not run browser or desktop E2E. Merge queue runs the
complete browser plus Linux and Windows Desktop Core suites before a commit
enters `main`; `main` does not repeat checks that already passed for the merge
group. The macOS memory gate runs only for non-draft PRs carrying `ci:all`.
Regular PRs, scheduled runs, and manual runs do not execute memory E2E. Applying `ci:all` runs browser, Linux desktop, Windows
desktop, and macOS memory E2E even when the PR's changed paths would not
normally select Wework E2E. The workflow also runs a regression excluding memory E2E every
day at 04:00 UTC. Keeping `ci:all` on a PR also runs all Windows Core shards
on subsequent pushes. Windows builds, shards, and the summary share one
scheduling condition; skipped required jobs fail the gate. The macOS memory
check invokes the Node checkpoint runner directly, including on build cache hits.
On macOS, pre-push checks use `caffeinate -is -w` to remain awake while running;
the assertion ends automatically with the hook, avoiding sleep-induced test timeouts.

Authenticated flows should create users and data through backend APIs before the test, then use real login or a real token injection. Do not mock backend HTTP responses in Playwright.

### Readiness for Local Project Scenarios

During installation reconciliation, plugin install/update primary actions and update confirmation reflect the same pending state as their handlers. Healthy installed plugins without updates remain available for immediate use. `plugin-runtime-path-recovery` retains its update confirmation, real invocation, uninstall, and restart assertions.

`voice-input` uses `clickWhenEnabled` for New Task on initial entry and after restart. Control-channel and telemetry-dialog readiness do not establish sidebar readiness. Preserve the shared 10-second action budget and all first-use setup, dialog dismissal, and post-restart assertions.

xterm updates all accessible row contents before batching transform resets, width measurements, and transform writes. This avoids per-row forced layouts. The dependency patch covers source, CommonJS, and ESM; a regression uses real xterm to verify all row contents are updated before the first measurement. `background-terminals` retains native paging, history, and accessibility assertions, with CPU profiles available to inspect layout hotspots.

Transcript conversion updates `runtimeStatus` together with the current message's `status`; a completed user message must not leave a stale status that overrides its streaming assistant. Smart app verification logs stage start, completion, and duration without environment variables or credentials. Locate stalled stages from these logs instead of extending E2E waits.

Smart app verification sets `NPM_CONFIG_WORKSPACE_DIR` to the project itself and disables implicit dependency installation before scripts. Typechecking, tests, builds, and runtime probes still execute. Verification must not read or install the containing host workspace. Real pnpm regressions cover a conflicting host package-manager version and prevent creation of its lockfile.

Desktop artifacts restore through `actions/download-artifact@v6`, including the upstream fix that rejects the pending promise on stream timeout instead of exiting successfully with a partial directory. See the [artifact SDK timeout fix](https://github.com/actions/toolkit/commit/523ce8ccda300661be06e592b615399fcfc282dc). Windows network-failure diagnostics retain connection states, dynamic/excluded port ranges, socket-exhaustion events, and memory-pool counters without process command lines or credentials.

Stand-in completion can arrive before the runtime unread flag. A new completion after observation starts must remain unread, and delivery must consult the current read ledger rather than consume it as restored history. Persist delivery records once per batch before sending alerts. Regressions cover late unread updates, no replay after reload, and a single delivery-ledger write for 1,000 records.

`createSingleRootLocalProject` must wait until the new project is the workbench’s current project. Closing the creation dialog or finding an older composer is insufficient. The cloud-context and running-history scenarios also select a registered model explicitly through `selectE2EModel` before entering the first message. Their stalled-context, attachment, history recovery, and task-move assertions remain intact.

The running-history scenario measures its three-second responsiveness gate with the workbench snapshot, excluding the debugger protocol cost of forced GC inside `performanceSnapshot`. Full history, pagination, transfer, and memory assertions remain intact. Windows restart checks still require the original executor to exit and record the selected PID’s process name and start time together with the `taskkill` exit code and output, distinguishing a surviving executor from PID reuse without collecting process command lines or environment variables.

Windows restart gates compare process instances by PID, process name and creation time instead of checking only the old PID after launching the new app. The same PID with a different creation time identifies a new instance; a surviving original instance still fails. Failed identity queries and missing creation times also fail. Keep the original model-proxy reconstruction, conversation restoration, follow-up assertions and UI timeouts. See [Windows process handles and identifiers](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers).

Checkpoint tasks use the existing 30-second model-request budget before starting the original 10-second UI completion assertion. Model startup does not consume the rendering budget. Await submission and request observation together so an observer timeout after input failure cannot become an unhandled rejection; the original error still reaches normal diagnostics and cleanup.

After a held cloud model request times out and is cancelled, explicitly refresh the catalog by opening the real model selector, then close it so recovery can reopen it. Local model settings events refresh only the local catalog; repeatedly dispatching them cannot replace a cloud refresh. Preserve the cloud failure, recovery, model provenance and plugin assertions.

When a blank conversation submission completes, reuse the current-task identity check and consume its draft key only if the created task is still selected. A late completion from the previous request must not clear text entered after returning to a new conversation. Rejected creation still restores the original draft and attachments. Regressions cover delayed creation and delayed refresh; the original nine-task bulk completion and archive E2E remains unchanged.

Chunked history transport names immutable snapshots by their compressed-content hash. Concurrent requests reuse the same file through atomic publication without replacement, avoiding replacement of a snapshot being read on Windows. Regressions preserve the published file and its modification time, keep active readers valid, and restore the complete history from four concurrent requests. The original running-history E2E remains unchanged.

Submission diagnostics retain Enter composition suppression, configured send key, and submission guard state (content presence, model readiness, and disabled controls) in the existing bounded composer event buffer without recording draft text. Trace native input, submission decisions, and Executor requests in order; the final button state does not establish its state when a key arrived.

On a Windows socket-buffer error, the desktop runner immediately saves one port, process, memory, and TCP-event snapshot (`windows-network-exhaustion-at-error.json`) alongside the existing failure-time snapshot. An application-startup timeout can outlast TCP port reclamation, so its later snapshot cannot exclude allocation failure at the original error. Diagnostics neither retry requests nor replace the original failure.

Publish native editor callbacks only during React layout commit. A suspended concurrent model-readiness render must not replace the send handler of the visible composer. Regressions cover native callback identity and the actual shared submission guard: an enabled composer submits with committed model readiness and remains usable after abandoning the suspended update.

Isolated Windows desktop E2E launches disable Chromium `TcpPortRandomizationWin` so rapid loopback connections use normal OS port allocation. Electron 44.7.0 / Chromium 152.0.7977.130 enables this feature by default; upstream [572515601](https://issuetracker.google.com/issues/572515601) confirms WSAENOBUFS at low connection counts on Windows Server 2025 and other affected systems. Repository logs record native `ERR_NO_BUFFER_SPACE` together with TCP event 4231. Merge existing scenario feature switches and deduplicate entries; retain startup, model HTTP-error, and resource assertions.

The Windows desktop E2E test step has a 40-minute budget within the 60-minute job limit, leaving time to upload failure logs and diagnostic artifacts. A previous Core shard 7 hit the job deadline; its job-log endpoint returned 404 and the run log archive omitted that shard, so evidence could not be recovered from the destroyed runner. Step timeouts remain failures and retain the existing always-run uploads.

Executor RPC completion only establishes that the Executor returned a result, not that HTTP delivery finished. DSH separately records response `finish` or premature `close` events and stream state. Desktop E2E calls use unique request IDs and distinguish response-header and response-body failures, retaining elapsed time, length and encoding metadata without parameters or bodies. The plugin development child records source events, relative paths and reload generations to distinguish missing file notifications, duplicate reloads and UI synchronization failures. Diagnostics add no retries or timeout extensions.

One Windows source write can produce multiple file notifications; time debouncing does not merge every late event during a restart. Plugin development compares file content and permission digests with the last successfully loaded version to avoid duplicate reloads. New content, deletion/recreation and new notifications after a failed reload still trigger loading. Directory and unnamed notifications retain their existing reload behavior. Original HMR generation and functional E2E assertions remain unchanged. Focused Electron test paths and `-t` filters route together to Electron without starting an unrestricted renderer suite.

Long-history transport buffers JSON serialization fragments before feeding gzip's fast level, reducing small writes from escaped content and compression cost for interactive reads. The regression uses the original high-entropy Unicode/emoji history fixture to verify over two orders of magnitude fewer compressor-input writes with identical JSON bytes and explicit propagation of final buffered-write failures. Existing complete restoration, chunk limits, concurrent snapshot reuse and long-path coverage remain enabled. Phase logs record packing, compression and publication duration plus compressed byte counts without bodies. Chunk size, completeness assertions and hydration deadlines are unchanged.
