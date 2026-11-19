---
sidebar_position: 39
---

# AI Verification Sessions

Wework can start an isolated development verification session so an AI can operate and assert against the real Electron application. It reuses the desktop E2E WebView control channel, never drives an external Chrome window, and does not attach to a developer's everyday Wework window.

## Desktop E2E error collection and assertions

Desktop checkpoints use a real Backend, database and MinIO. Network proxies inject holds, disconnections and recovery without fabricating Backend responses. Model services may use protocol fixtures. Explicit owner exceptions also permit external Sites and GitHub/GitLab protocol fixtures, including Git CLI replies. DingTalk external protocol tests allowed by the contributor guide follow the same labeling rules without expanding the permitted substitution boundary. Wework, Backend, plugin publication/installation/activation and device credential synchronization remain real. Label affected checkpoints and reports as protocol integration tests, with `verificationType: protocol-integration` and `sites`, `git-hosting` or `dingtalk` in `externalServiceProtocols`. The shared DingTalk fixture registers its protocol during preparation; final reporting merges scenario declarations and used substitutes without overwriting existing registrations. Real external provider compatibility remains unverified; these exceptions permit no other service substitutions. Extension scenarios requiring Nevis restart support must configure a real isolated service.

The shared runner binds checkpoint owner identities and derived conversation IDs from the real `/api/users/me`, without fixed IDs from the former fake Backend. Connected scenarios establish native desktop credentials through real authorization sessions and use the same Backend address in the renderer and Host. Login scenarios explicitly start disconnected. Network failures retain the target origin, path, request ID and resource type, excluding URL user information and query parameters. Explicit informational diagnostics use a separate protocol in the same journal. Original warnings/errors retain their severity; malformed diagnostics become collection protocol failures.

Public CI cloud restart coverage uses an isolated process controller to stop and restart both Executors in one sandbox, preserving main's authorization, busy rejection, offline and recovery checks. The controller fabricates no Nevis or metrics replies. This verifies actual process lifecycle behavior, without claiming Nevis service compatibility.

The shared desktop runner creates `errors.jsonl` before launching the app and exposes queries and assertions through `control.errors` and the scenario factory's `errors` argument. The journal does not rotate or truncate stacks. Entries carry a PID, collector instance ID, per-instance sequence, timestamp, source, type and severity. Restarts receive a new instance ID. Values use the existing log redaction rules before writing. The journal, logs and screenshots are test artifacts and must not be committed.

The following table identifies implemented boundaries, rather than claiming that every application path has been exercised.

| Source                               | Connected error exits                                                                                                                                                                   | Focused verification                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Main process                         | Startup logging, console warnings/errors, uncaught exception monitor, including rejections promoted to exceptions by the default policy                                                 | `electron/src/host/e2e-error-sources.test.ts`                                                               |
| Renderer                             | Console warnings/errors, load failures and process termination for WebContents; window errors, unhandled rejections and explicit `captureError` in the Wework page                      | `src/e2e/error-capture.test.ts`, `electron/src/host/e2e-error-sources.test.ts`                              |
| Managed runtimes                     | Complete stdout/stderr, spawn errors and unexpected exits for Core DSH/Executor processes managed by RuntimeSupervisor                                                                  | `electron/src/host/e2e-error-sources.test.ts`, using a real child process                                   |
| Desktop driver                       | Native driver output, failed replies and connection failures                                                                                                                            | `electron/src/host/computer-use-driver-process.ts`; real desktop fault verification remains required        |
| Host protocol                        | Failed capability replies and protocol parsing failures                                                                                                                                 | `electron/src/host/e2e-error-sources.test.ts`; existing HostPipe unit tests cover capabilities              |
| Page request boundaries              | HTTP transport and failed responses; Host/Executor/Terminal business failures, including HTTP 200, malformed protocols and connection failures; Executor/Terminal stream disconnections | `src/e2e/error-boundaries.test.ts` and existing transport unit tests                                        |
| Network and Electron child processes | Session network failures, HTTP 4xx/5xx and unexpected Electron child termination                                                                                                        | `electron/src/host/e2e-network-errors.test.ts`; real Electron event wiring still needs desktop verification |
| Collector                            | Missing startup or required sources, gaps/duplicates, partial records, serialization and write failures                                                                                 | `scripts/desktop-error-collector.test.mjs`, `electron/src/host/e2e-error-log.test.ts`                       |

Asynchronous subprocess lifecycles register automatically through Node's native `child_process` diagnostics channel. Node Workers register through the native worker event. `errorMonitor` observes failures without taking over existing error handling. Real process/thread tests are in `electron/src/host/e2e-process-errors.test.ts`; driver boundaries also have `computer-use-driver-process.test.ts`. External-command pipes are not consumed for observation. Owned managed-runtime and driver output is collected at existing consumption points. Worker output is observed only when already consumed, without changing its stream mode. Unobserved streams produce an integrity failure rather than a completeness certificate. Nonzero exits and signal termination are conservatively recorded as error facts; expected deliberate termination needs explicit assertions too.

Across restarts, acknowledge the old process's interval before it exits, then take a new `mark()` in the new process. Asynchronous certification rejects intervals spanning collector instances: the current process cannot certify an earlier process's final output.

Scenarios explicitly invoke assertions. The runner does not convert existing intentional-failure scenarios into zero-error scenarios. Prefer `assertCollectedErrors`: it requests a persisted checkpoint through isolated verification IPC, checks cumulative write failures, sequence and committed byte offset, and validates a stable snapshot through that offset. A failed final write cannot pass even if stderr evidence was lost. `assertErrors`/`assertHealthy` inspect local records and do not replace native acknowledgment. Use an empty expectation array for normal flows. Match expected failures by source, code, type and exact count, and reject remaining errors:

```js
control.errors.assertHealthy({ sources: ["main", "renderer", "runtime"] });
const after = control.errors.mark();
// Perform the operation and wait for its observable result and error report.
await control.errors.assertCollectedErrors(
  control,
  [
    {
      description: "The executor reports the injected failure once",
      match: (event) =>
        event.source === "renderer" &&
        event.type === "executor:example.operation" &&
        event.details.code === "injected_failure",
      count: 1,
    },
  ],
  { after, source: "renderer", sources: ["main", "renderer", "runtime"] },
);
```

Omit `source` and `type` to check all errors in the selected interval. Filters establish only the selected boundary. `query` also exposes raw runtime output. Stdout is informational; stderr is conservatively classified as an error. Output chunks are not business-error counts. Query warnings separately. Wait for the actual report before asserting; fixed delays do not establish collection completion.

The existing `core-task-flow` checkpoint adds a collection self-test: emit one explicit `collector-probe`, wait for its real journal entry, assert exactly one occurrence, and verify persistence through the native checkpoint. It reuses the existing CI, build and app instance, without another E2E job. The deliberate error remains in the journal; use `mark()` for subsequent operation intervals rather than a global ignore rule. This added E2E coverage becomes actual Electron evidence only after execution.

Coverage acceptance requires connected exits, fault injection and actual desktop execution evidence. A registered process or window does not prove every error exit was tested. Silently swallowed exceptions, unreported business failures, independent Web Workers, custom Sessions whose network listener is subsequently replaced, and final output lost during forced termination are not automatically certified by this journal. If the process stops or disconnects before acknowledging a checkpoint, the asynchronous assertion must fail. Historical packages without instrumentation must fail explicit health assertions rather than treating empty journals as success. Plugin and external-service coverage ends at returned results, connections and protocols. New exits require reporting and fault tests. Do not claim complete owned-process coverage or zero loss before these checks are fulfilled.

CI and the shared runner use the same result cleanup implementation. Actual checkpoint-owner and desktop-process-group liveness determines whether a result directory can be compacted. Working directories, runtimes and caches remain intact while either is alive, so cleanup cannot cause missing-file errors in children still executing after cancellation. Rebuildable content is removed only after exit; diagnostic files remain. Forced cancellation can still interrupt final acknowledgement or artifact upload. Reports missing their corresponding raw stream, final summary or acknowledgement cannot certify completeness, even when their numeric report marks collection complete.

## Measuring UI updates around operations

The shared runner's `control.refreshes` (also the scenario factory's `refreshes` argument) brackets one or more operations, persists `ui-refresh.jsonl`, and supports regional update budgets. The shared control connection also opens an automatic checkpoint capture; explicit and automatic captures reuse one MutationObserver. Windows can overlap; stopping drains pending records rather than guessing completion with a fixed delay. The operation callback must wait for actual business results. Use existing negative observation windows to verify that no further updates occur over a subsequent interval.

Interpret metrics separately:

- `renders` counts instrumented component function calls, including StrictMode repetitions and abandoned render attempts. Built-in boundaries are `app`, `workbench-provider`, `desktop-sidebar`, `desktop-workbench-main`, `workbench-conversation`, and `right-workspace-panel`. Multiple instances of a component type aggregate within the current renderer. Reuse `recordUiRender(id)` for finer boundaries.
- Regional `mutationBatches`/`mutationRecords` count observed DOM write batches/records within the CSS selector, not browser paint frames. Batches include observer delivery and explicit drains. Nested regions are independent and must not be summed as global refreshes.
- `rootRemovals` counts selected roots being removed. `maxAddedSubtreeElements`/`maxRemovedSubtreeElements` report the largest inserted/removed subtree observed at delivery, revealing broad node replacement in a single update. They are not exact historical insertion totals or pixel repaint areas.
- `addedSubtreeElements`/`removedSubtreeElements` accumulate subtree element sizes observed at mutation delivery. Counter differences measure work within an operation window, including smaller replacements after an earlier larger replacement, and support region budget assertions. When a common ancestor outside the selected region is replaced, totals include all disjoint matched roots, nested matches count once, and maxima retain the size of an individual matched subtree. Repeated moves of the same nodes count repeatedly; these are neither unique-node counts, exact historical insertion totals, nor pixel repaint areas. Missing fields in older reports are unavailable, never zero; `max*` remains the maximum across the capture.
- `reactCommits` reuses the `wework-root` Profiler, including fast commits and cumulative actualDuration without the existing slow-commit threshold. Its scope is the App's Profiler subtree. Verification artifacts built with `VITE_WEWORK_E2E=true` use the React profiling entry to record actual commits. Ordinary release artifacts do not enable this entry. For artifacts without profiling, absent effective callbacks still produce `null`, not DOM batches presented as commits.

An existing `operationAndWaitForResult` callback can contain multiple operations and business waits. Use the zero-sidebar-update budget below only when the scenario explicitly requires the sidebar to remain unaffected. Other budgets require requirements and actual measurements; there is no guessed global threshold.

```js
async function verifyLocalOperation(control, operationAndWaitForResult) {
  const result = await control.refreshes.measure(
    "local-panel-operation",
    {
      regions: [
        { name: "sidebar", selector: '[data-testid="desktop-sidebar"]' },
        {
          name: "conversation",
          selector: '[data-testid="desktop-workbench-pane-stack-container"]',
        },
      ],
      renderIds: ["desktop-sidebar", "desktop-workbench-main"],
    },
    operationAndWaitForResult,
  );

  control.refreshes.assertWithin(result, {
    regions: { sidebar: { mutationBatches: 0, rootRemovals: 0 } },
    renders: { "desktop-sidebar": 0 },
  });
  return result;
}
```

Manual `start(label, options)`/`stop(token)` supports separate operation windows. Use stable product CSS selectors. Never-observed regions, uninstrumented components, misspelled metrics, and unavailable requested profiling cannot pass as zero. Set a region budget's `allowAbsent: true` only for explicit expected absence. Labels should be fixed operation names without user input or credentials. Evidence contains identifiers, selectors and numbers, without DOM text or HTML.

Capture windows include background activity and do not establish causal attribution. Each capture binds to its starting control client: switching windows does not mix another renderer's counters, and windows can be captured separately. Reloading or losing the original renderer/capture fails completion and persists `complete: false`, rather than returning zero. DOM metrics cover the selected DOM in that document, excluding iframe and Shadow DOM internals; they are not pixel repaint metrics. Operation failures still attempt metric collection and preserve the original failure; simultaneous collection failures are reported together. The existing `core-task-flow` adds a real DOM transient-root mutation/removal self-test using its existing CI and app instance. Wiring coverage does not constitute executed Electron evidence.

While a verification control client is connected, a scoped conversation-diagnostic lease keeps capture active beyond the ordinary ten-second interaction window. Client completion and registration failure release the lease. The existing ring remains bounded to 400 sanitized events and reports dropped counts. ResizeObserver error snapshots also include these already-recorded scroll and layout events without reading the DOM. Ordinary product interactions retain their short capture window.

## Per-checkpoint performance diagnostics

The shared desktop control protocol automatically carries cumulative metrics with ready/started/results acknowledgements. The journal merges snapshots by renderer capture ID into each result directory's `performance.json`. Existing desktop jobs publish a per-checkpoint table and dedicated numeric artifacts. This phase analyzes the current run only: it neither produces a main baseline nor compares historical totals. Reports explicitly declare `baselineStatus: not-established` and `comparisonValidated: false`.

When a visibility wait fails, the shared controller also records animation play states, pending flags, finite numeric times, and boolean data states. Inspection happens only after failure, scans at most 128 descendants, and emits at most 16 state/animation entries with omitted counts. Missing APIs or failed reads remain unknown rather than zero animations. Do not record text, inputs, keyframes, or non-boolean data values. These diagnostics distinguish dismissal state from exit motion without changing waiting, closing, or rendering behavior.

Metrics cover DOM records, node additions/removals and subtree maxima, instrumented component render attempts, React commits when available, Executor RPCs, independent describe requests, event types, full/pending task reads, connection starts and failures. Explicit AbortSignal cancellations are counted separately. Navigation-related network aborts remain recorded facts for lifecycle analysis. Duplicate arrivals and actual duplicate deliveries are distinct. Parse/protocol failures remain visible for investigation, including intentional fault injection that needs explicit interval assertions.

`executor.parseFailures` and `executor.protocolFailures` count response-body/event decoding and protocol-shape validation in the frontend Executor/DSH transport. Zero does not establish the absence of parsing/protocol errors inside the native Executor, Codex or external services. Native JSON-RPC failures, rejected prediction JSON and HTTP route rejections still require their process and request-boundary evidence. `executor.cancellations` covers explicit local cancellation with an aborted AbortSignal; server cancellation errors remain recorded error responses. A representative message for one error code cannot classify every record sharing that code.

`observations` retains nonzero metric deltas at command start/result boundaries, command IDs and action names. The first observation of each counter within a capture also retains zero, distinguishing observed inactivity from unknown coverage. Regions that become observable later start at their first valid snapshot; earlier intervals remain unknown. Older artifacts lacking these zeros remain unknown, and cross-capture totals cannot establish an operation's coverage. This separates operation intervals from inter-command background work without claiming causality. Evidence contains type names, identities and numbers, never parameters, event bodies or credentials. Identical method names can target different resources and do not establish redundant work. Use `control.refreshes` for narrower regions and business waits.

Measurement spans control registration through the last received acknowledgement, with a final active-client snapshot before cleanup. Earlier startup work and work after a closing/reloading renderer's last acknowledgement are outside this window. Missing evidence, resets and unavailable metrics must remain incomplete instead of becoming zero. E2E verification builds enable production profiling; ordinary release builds may still return null commit metrics. Error persistence has a separate completeness contract.

Analyze measured variation before establishing a baseline: distinguish startup, polling, business actions and lifecycle termination. Runner contention affects timings and polling counts. Keep renders, DOM mutations and paint frames distinct. Future baseline enforcement still requires an explicit first-establishment phase and must never silently bootstrap again after trusted baseline evidence is lost.

Windows scheduling uses verified successful checkpoint durations, retaining larger historical costs and their sources while removing alias weights unused after group expansion. Failed, interrupted, and unobserved checkpoints cannot become successful samples. Add one shared runner only when the complete Core workload's known movable cost exceeds existing process capacity and that runner makes it fit. Partial selections, sufficient capacity, and an oversized task that one runner cannot resolve receive no expansion. Preserve both exclusive shards, preparation groups, unknown-work ownership, and scenario coverage without increasing search, step, or process deadlines. Contract tests check the capacity configuration against the native Windows wrapper's actual deadline. Unknown costs remain explicit; scheduling weights are neither a main performance baseline nor proof of performance.

`coordination-history` uses real SQLite, scheduler and native tasks to verify that a large failed-history backlog does not block new work and that background retention progresses. Retention scans indexed candidates outside a write transaction, then requests nonblocking write admission for at most 25 records before checking references and committing. This prevents unrelated WAL commits from invalidating a read snapshot during write promotion. An existing writer still makes maintenance yield immediately, and WAL readers remain available. The 100ms scheduling budget, four-commit limit and reference protections remain unchanged; the budget never interrupts an admitted transaction or extends the E2E deadline.

### Counting semantics and fault diagnosis

Project-space task context lookups emit `project-space-task-context-lookup` with a lookup identity, source indices, outcomes, sources still pending at the deadline, and late results. `project-space-task-context-failed` retains handled failure messages and stacks, including individual aggregate causes; existing warnings remain separate records. These diagnostics distinguish lookup deadlines, source failures, and late delivery using identities and diagnostic fields without request bodies.

`observations` retains wall-clock sample times and renderer elapsed time; `captures` retains each renderer's start/end times. Totals alone cannot establish request frequency. Commands are counted once at started, not twice for started/result acknowledgements.

Subtree removals use the region containing `MutationRecord.target`; detached nodes cannot establish their former membership through current `contains` checks. Each operation window retains the latest 32 removals with test identifiers, at most 16 identifiers per entry and elapsed time. The shared journal saves new entries at command boundaries without retaining DOM text or node references.

Controlled transport replays retain the raw duplicate-delivery count and separately record `injectedDuplicateDeliveries`. Only duplicates without real fault-injection provenance are marked as invariant anomalies. Provenance comes from the shared transport gate, with no scenario-name exemptions or error ignore lists. Wire replays discarded by deduplication remain separate facts.

ResizeObserver loop errors include the latest 32 native observer callbacks: construction stacks, callback names and up to four targets' test identifiers, tags and dimensions. Each callback also records its DOM write count and up to eight write targets' tags, test identifiers and attribute names to locate measurement/write loops. Diagnostics capture no DOM text or attribute values, add no layout reads, change no callback timing and suppress no error. This bounded context does not certify complete historical resize delivery. The latest 32 batches of DOM writes between callbacks also capture deferred commits, with timestamps and up to eight targets; temporal adjacency does not establish causation.

Transcript cancellation is recognized from the actual AbortSignal and matching rejection; each layer preserves cancellation and the original rejection without duplicating it as a fault. Other failures racing an aborted signal remain reportable. Goal and project-context reads for optimistically opened tasks wait for the same real creation Promise; departing views cancel their own reads while independent tasks remain unaffected. The new `runtime-task-readiness` checkpoint reuses Core CI, holds the actual create request, proves a reader reached the barrier without dispatching RPC, then releases it and verifies the real model result and goal response. No fixed delay establishes readiness.

The `assertions` field in `errors-summary.json` records error-matching assertion ranges, pass/fail outcomes, expected counts, and record identities. Only assertions verified against a native collection checkpoint include its identity and byte offset. `assertionCoverage` deduplicates records with `level=error` into asserted, natively acknowledged, and unasserted counts. Repeated assertions do not inflate coverage; failed assertions provide no passing evidence. Receipts copy neither error contents nor descriptions, and a scoped acknowledgement does not certify a globally error-free run. Assertion coverage remains unknown for older artifacts without these fields.

## Idle Executor request regression

`idle-executor-requests` uses isolated real Electron and Executor instances with no tasks and no cloud connection. It reuses the shared runner's initial telemetry refusal, reloads the main window, and observes requests. Worktree capability discovery, telemetry configuration, and the shared SSE subscription must each occur once after reload. Foreground and close-to-background observation windows each last 6.5 seconds, crossing the five-second poll interval: pending-interaction discovery and Runtime identity checks must continue, without full task-catalog polling or repeated startup configuration. Known asynchronous bootstrap requests, such as plugin initialization, may finish; a fixed delay is not used to infer startup readiness.

Native discovery still runs after returning a cached task list. It sends a work-change notification only when the visible project/task response changes or Native catalog discovery fails or leaves unread pages. A complete, unchanged reconciliation does not trigger another full read; incomplete coverage still triggers the authoritative full query and is never treated as a complete catalog.

Identity descriptions share only not-yet-dispatched requests within the same synchronous batch; post-operation identity checks still fetch fresh descriptions. Confirmed local Runtime telemetry policy is not rewritten on idle polls. Runtime, account, API, or policy changes resynchronize it, and failed writes retry. Work-list changes refresh task data only; device events and explicit refresh retain device discovery. Work events preserve an in-flight full cloud sync and coalesce into one fresh work read afterward. Bootstrap device and team synchronization is not discarded when the task-read revision changes.

Telemetry configuration, listing, and acknowledgment run synchronous SQLite work on the existing blocking pool rather than occupying asynchronous RPC dispatch while waiting for a writer. The focused regression holds a real second-connection write transaction, verifies that configuration yields on its first poll and a concurrent read completes, then releases the writer and verifies successful saving. Consent policy, transactions, database waiting, and E2E deadlines remain unchanged.

Last-project restoration waits until the initial local work-list load settles; an earlier cloud-composed list must not consume that restoration attempt. Device and cloud catalogs may publish independently, without implying that local projects are ready.

```bash
pnpm --filter wework e2e:desktop --segment idle-executor-requests
```

The independent checkpoint is registered in an existing Core CI shard and does not require earlier scenarios. Local macOS arm64 verification took approximately 52 seconds including startup and cleanup, excluding the shared build. Its result directory contains `idle-executor-requests.json` with method names, timestamps, statuses, and necessary boolean flags only, never request parameters, headers, or query strings. Do not commit logs or screenshots.

## Periodic plugin recovery E2E

Automatic plugin-sync discovery waits for acknowledgement of the current Backend configuration, independently of Device/Socket connectivity. Shared connection state tracks configuration readiness separately; a transient status-query failure does not erase an acknowledged configuration. Account or Backend changes reset readiness. Before its business flow, `plugin-auto-update` uses an acknowledged error-collection checkpoint to assert that startup plugin synchronization had no failures, so premature discovery is not accepted as normal startup.

The `plugin-periodic-reconcile` checkpoint uses real Electron, Executor, Socket.IO, database, and plugin package storage. It discards one real plugin change notification, then verifies timer-driven recovery, persisted acknowledgements, device identity, and unchanged unrelated plugin content. Its isolated instances set `LOCAL_PLUGIN_RECONCILE_INTERVAL=90` and `LOCAL_PLUGIN_RECONCILE_JITTER=18` (seconds), with the existing `LOCAL_HEARTBEAT_INTERVAL=1` configuration preserving the assertion of at least 10 heartbeats. The checkpoint observes production reconciliation ticks and aligns fault injection to the current timer window when fixture setup crosses one, so setup load cannot force a longer interval.

Without overrides, production retains a 600-second base period plus a stable per-Runtime offset of 0–119 seconds and 30-second heartbeats. Invalid or non-positive integer values use the defaults. The test neither invokes reconciliation manually nor replaces the real timer.

```bash
pnpm --filter wework e2e:desktop:cloud -- --segment plugin-periodic-reconcile
```

The plugin account late-response E2E uses a unique `Server-Timing` diagnostic marker on the selected fault-proxy response while preserving its real upstream body bytes. Verification identifies the renderer's actual consumption of that response before checking stable current-account inventory. Browsers may record multiple fetch consumers for one HTTP response, so a time window containing exactly one entry cannot establish response identity. Protocol tests protect byte preservation and coalesced-consumer correlation; the existing desktop checkpoint still verifies real account/device boundaries.

## Conversation model restoration diagnostics

When full task data is selected, the feedback bundle's `context/task.json` includes `modelSelection`: `configured` is the configuration supplied to the model selector, `effective` is the configuration after default resolution, and `selected` is the current composer model. Missing snapshots remain `null`. Snapshots contain only model identity, resource ownership and a diagnostic fingerprint; arbitrary model options and authentication configuration are excluded.

The `workbench.selection_restored`, `workbench.selection_changed` and `workbench.selection_seeded` events in `logs/app/model-loading.log` correlate scopes and models through numeric fingerprints. Fingerprints are diagnostic identifiers. The executor's `runtime task model selection updated` event records an in-memory assignment. The `runtime task get resolved link` and `runtime task transcript resolved link` events record the owning task's current model identity on reads. Assignment does not prove that a disk write succeeded.

Full workbench diagnostic snapshots also include `modelLoading`: a copy of the current renderer’s latest 200 startup and request-phase events, including events not yet flushed by the 10-second persistence timer. This bounded window supplements host logs and is not a complete event history; it restarts on window reload.

`configured` is not the raw on-disk task record. Existing conversations receive configuration from the task summary or runtime handle; new conversations can receive project configuration or user preferences.

1. Export feedback before restarting.
2. Restart the app.
3. Export feedback before the first send.
4. Check the model identity read by the executor.
5. Compare the composer's configured, effective and selected models to distinguish missing records, default substitution and composer changes.

## Prepare desktop E2E prerequisites before startup

Use the shared `ensureLocalModelCatalogReady` control command to establish local catalog readiness. The current model button’s `data-model-provider-id` describes a selected local Codex provider: a valid cloud selection can omit it while the local catalog is ready. Keep separate assertions for catalog deduplication, target options, and protocol behavior, without replacing a valid selection because sources initialized in a different order.

Session network failures include `sinceSendHeadersMs` (first observed header send through failure or HTTP completion) and `responseHeadersAfterSendMs` (first send through response headers), measured with the host monotonic clock. Unobserved stages remain `null`, never zero. These exclude queuing before header send and do not measure server processing time. Timings are scoped by Session and request ID and released on completion; an overridden default-Session error callback must pass its Session to the shared recorder. Only timings and existing safe fields are retained, without headers, bodies, or query credentials.

Concurrent requests can receive cloud-config failures from the same native process. Each RPC records the process generation that actually admitted it. Recovery checks that identity under the auth-state lock, acting only on that process or joining Router recovery another request already completed for it. Router mode alone never authorizes replay. Unknown outcomes, unrelated generations, explicit official-subscription requests, and dedicated Homes do not join this recovery. Existing permission restoration and deadlines remain enforced. Child-process contracts verify a late failure joining recovery, exactly one thread creation, and these rejection boundaries using a synthetic Codex protocol service; they do not certify an official runtime fix or waive real E2E gates.

The shared controller allows overlapping Runtime requests, so results can arrive out of order. The performance journal inserts every snapshot by elapsed time within its capture, retaining command boundaries and recalculating adjacent deltas and removal annotations. Network arrival order does not determine counter monotonicity. Client identity and capture start time must remain stable; genuine regressions or missing counters after ordering still make collection incomplete. Equal elapsed times retain arrival order and do not resolve uncertainty.

When cumulative snapshots regress, reuse a source identity, or omit required fields, `performance.json.rejectedSnapshots` retains the rejected operation boundary, prior/current elapsed times, and regressing counters to investigate resets versus delivery order. The report remains incomplete and rejected values never overwrite acknowledged metrics.

Windows native-decision diagnostics distinguish UI Automation assembly loading, enumeration start/completion, owned-window presence, and title matching. Each fixed stage is emitted once without window text. The host records an action-only event before calling the native confirmation API, separately from the final decision; this event does not prove the OS displayed a window. Existing PID/title/button constraints, the 10-second search, and the 12-second process deadline remain unchanged. Diagnostics cannot convert failure into success.

Personal plugin listing and cloud-link reads share marketplace-root resolution. A marketplace that has not been created requires no directory or catalog write; only an absent link registry means an empty list. Independently retained link metadata is still read, while corrupt JSON, permission errors, non-directory roots, and symbolic links remain failures without clearing or overwriting data.

Prediction JSON parse failures retain byte length, JSON error category, and line/column positions; completion events identify the source and prediction threads. Neither response bodies nor raw parser messages are recorded, and invalid JSON never becomes a successful empty suggestion.

Prediction forks preserve a source connection loaded in the current native process and retained by an MCP App session, even without a model-turn configuration cache. They neither reconfigure that source nor forcibly unsubscribe it after forking. App-only sources join the existing idle-generation tracking so the normal cleanup policy still applies after the last App session releases them. An App session registration alone does not prove source residency after a process restart: source configuration must still be restored, and temporary prediction threads remain subject to cleanup.

Native JSON-RPC errors use the existing stderr and rolling log writers so stdout/info collection cannot classify them as ordinary output. Returned errors, redaction, and size limits remain unchanged. The existing `core-task-flow` collection probe adds an invalid parameter type to read-only `config/read`, requiring the official runtime to reject it and its native `-32600` diagnostic to reach stderr/error. The probe assembles complete lines by collector instance and child process without depending on OS chunk counts. It asserts this failure's presence without acknowledging adjacent unknown errors, replacing the renderer's acknowledged collection assertion, or certifying that every runtime error has been asserted. Focused child-process tests verify the error stream and redaction; real end-to-end results come from CI.

The shared desktop runner writes the final `performance.json` after application, controller, service and result cleanup. Teardown assertions and late controller errors set `functionalPassed=false` and preserve `failure.txt`; an existing scenario failure and its original evidence remain primary. Diagnostic write failures cannot turn a failed run into success. Model requests and HTTP timing/status metadata are also written to `model-requests.json` and `http-requests.json` after the controller closes, including requests arriving during teardown. The shared runner first saves model, HTTP and command evidence before cleanup; this partial evidence does not produce a passing performance report. `teardown.jsonl` records each phase starting, completing or failing, plus readable/writable lifecycle state and buffered byte counts before process-log drainage, without output contents, command arguments or environment. Async resource diagnostics continue through final teardown; a hung cleanup never turns partial evidence into a pass. Metric completeness remains separate from the functional outcome. Existing model-discovery stage logs also carry a compile-time caller file/line and query ID to distinguish public catalog reads from internal queues, coordination and conversation creation, without request parameters or response content.

Both successful and failed scenarios write `command-history.json` after teardown. Command IDs link metric observations to operation targets, renderer clients, queue/delivery/start/completion times, and outcomes. A fixed field allowlist excludes input values, expected text, headers, and additional payloads; failure-only `scenario-state.json` no longer duplicates full command objects. Correlate operations and timing before attributing a large DOM replacement to a nearby `fill` or `click`.

Model evidence recognizes fixed endpoints, versioned endpoints under a base path, and Responses compact without widening the default handler. Model requests are registered before entering a scenario handler. Successful custom handlers, approval reviews, predictions, and the default model path each retain one record, including requests whose handlers are still pending or fail during teardown. `httpRequestIndex` in `model-requests.json` identifies the corresponding entry in the sibling `http-requests.json`. Persistence allows only body, scenario, protocol, correlation index, and failure flag; Authorization, headers, and additional authentication fields are excluded.

Shared DOM wait failures also record poll count, last poll time/match count, elapsed time and the largest observed poll gap; absent polls remain unknown. A matching element in the final snapshot does not prove availability within the deadline. These fixed numeric diagnostics distinguish late conditions from delayed checks without extending deadlines, retrying or converting a timeout into success.

The shared Windows native decision client uniquely matches the existing titles, PID and `#32770` dialog class. CI observed no buttons in the UIA descendant tree while Win32 found two actual Button controls in the same dialog. The client therefore enumerates visible, enabled Button handles owned by that dialog and process, resolves them through UIA `FromHandle`, and performs the real click with the existing `InvokePattern`. It still requires a unique match against the original allow/cancel labels and revalidates ownership, ancestry, class, visibility, enabled state, UIA type and name before invoking. It uses no coordinates, keys or message injection. Windows CI also verifies Allow and Cancel return values using real OS dialogs owned by disposable child processes; these do not substitute for Wework scenarios. The existing ten-second search and twelve-second input deadlines remain. A zero-button observation retains one read-only UIA count snapshot. After any input failure, including registration failure, a separate read-only Win32 observer has at most four seconds to reselect the same PID, class and titles; it records handle, PID/class and child/button counts only for a unique match. Missing, ambiguous, invalid or unexecuted observations remain unknown, and diagnostic failure preserves the original input error. Control text and arbitrary class names are not logged. Diagnostic counts neither replace a real decision nor establish that real Wework E2E verification has passed.

Local model route rejection diagnostics record the route scope, requested thread/parent identity, binding count and matching-route count; missing identity remains unknown. Prediction-fork binding also records its selected scope, whether the parent was registered and whether it selected the prepared route, distinguishing inherited routing from later rebinding. Extra identity parsing occurs only on the existing rejection path. Diagnostics capture no route token, authentication or request body, and preserve the 409 rejection and error assertions.

General Tests selects the runner's existing `ubuntu.sources` explicitly through `WEGENT_CI_APT_SOURCE_LIST` for Ubuntu native verification. The shared installer uses the same source scope for index updates and installation, so unrelated third-party repositories do not block GDB preparation. Source files, distribution mirror addresses and signature trust remain intact. An unreadable selected file, index failure or installation failure blocks execution and preserves the original exit code. Preparation adds no retries and does not replace subsequent real Electron verification.

The Linux CI GDB crash wrapper emits one numeric identity record per real inferior through its existing thread event. The collected stream's `childPid` identifies the debugger owning the pipe, while native `executor_pid` identifies the error producer. Their relationship must be verified rather than treating both PIDs as equal. Missing relationship evidence remains unverified; PID proximity or adjacent logs are not proof. The existing native file-descriptor probe also requires one valid identity pair with distinct PIDs; exit results and stack gates remain unchanged.

Plugin batches use MySQL `NOWAIT` admission for every target parent after obtaining multiple installation leases. If another transaction holds any parent, the entire batch rolls back and releases its leases with the existing `plugin_write_busy` error, so one plugin's database wait cannot block another installation. Single-plugin coordination, atomic commits, parent CAS and ACK generation fences remain unchanged, without longer waits or added retries. The existing real MySQL/Redis concurrency suite covers rejection, unrelated writes and recovery after release; the original desktop E2E still verifies the business flow.

The Windows read-only observer compiles its existing C# interop source once during shared preparation, with the source SHA-256 in the assembly filename. CI distributes that same DLL with the existing E2E client artifact; checkpoints validate and reuse it. The local shared runner prepares it before starting checkpoints. The four-second observation only loads the assembly and enumerates windows, without starting the C# compiler. The existing one-minute Windows preflight, real Allow/Cancel verification and failure gates remain. Preparation failure or a missing matching assembly blocks execution rather than falling back to dynamic compilation.

Before the first UIA query, the Windows client explicitly registers the official `UIAutomationClientsideProviders` through `ClientSettings.RegisterClientSideProviderAssembly`, using the loaded UIAutomationClient assembly version and signing identity. Real CI confirmed that the official Button factory could create a provider for the same HWND while default queries returned Pane, so initialization does not rely on that environment’s default proxy binding. Registration errors remain failures, with separate start/completion stages. No custom provider or weaker Button/InvokePattern requirement is introduced; the real Allow/Cancel gate must still pass.

Real CI raised NullReferenceException when PowerShell called the official registration API directly; Microsoft’s implementation infers the referenced version from stack frames. Registration now enters through a named CLR method marked NoInlining, so version inference encounters a valid declaring type before dynamic PowerShell frames. It still calls the same official API and assembly; registration failures retain the original exception and gate. The independent native verification runs after Node 24 setup and before packaging in the existing Windows job, retaining its one-minute outer deadline.

Real Windows native verification can also fail an identity check after `FromHandle`. That failure branch records only three Boolean flags (PID, Button type and handle matches) and a numeric control-type ID, without names or arbitrary child output. Unavailable values remain unknown; diagnostic failure records a fixed stage and preserves the original identity rejection. Evidence must distinguish ownership from provider-type issues before behavior changes; these diagnostics neither waive validation nor prove that native clicking is fixed.

The existing `mcp-apps` CI checkpoint adds prediction coverage after restarting the Executor and restoring the App connection: it verifies exactly one real prediction model request, then uses an App call to check that the MCP service process instance remains unchanged, preventing automatic connection restoration from hiding an early closure. It reuses the real MCP service, Electron, Executor, and checkpoint, substituting only model responses, with no new runners or changes to existing counter assertions.

MCP App catalog failures retain task/thread identities, source-read status, whether restoration ran, and elapsed time since source lookup, without tool arguments or credentials. Native JSON-RPC failures also identify the process receiving the response (`shared` or `dedicated`) and its generation; request IDs are meaningful only within their process. Initialization and dedicated calls without a notification Hub explicitly record an unavailable generation as `unknown`, without borrowing a neighboring process's identity. Existing error redaction and size limits remain, with no new request-parameter or response-body logging. Windows native plugin decisions retain fixed UI Automation stages, exit signal, and termination state without arbitrary child output. These diagnostics support investigation and do not certify a fix or official runtime compatibility.

Windows confirmation searches each isolated-process top-level window subtree, accepting only the same process, Window control type, native dialog class `#32770`, and known confirmation titles. It invokes only matching native Button controls. Multiple matching dialogs fail rather than selecting by order. The 10-second search and 12-second child-process deadlines remain; real Windows behavior still requires CI verification.

Following [Microsoft's UI Automation threading guidance](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading), the shared Windows confirmation client explicitly uses PowerShell `-Mta` and retains its observed apartment state on failure. Only fixed `MTA`, `STA`, and `Unknown` values are accepted; missing or other values remain unknown. PowerShell's default STA is not the desktop automation client's execution contract. Observing zero buttons in a matched dialog does not prove enumeration blocked, and changing the apartment setting alone does not prove the real Windows failure is fixed.

Streaming text fixtures reuse `modelTextStream`, sharing Chat Completions and Anthropic framing with complete replies while retaining their chunk pacing and protocol-specific termination. Responses SSE sent to another protocol can cause native retries to arrive after the scenario advances and be mistaken for new business requests. Fixtures requiring a specific model catalog capability, such as `code_mode`, establish that prerequisite for every new conversation instead of inferring its model from the previous task. Generic text scenarios continue to cover the active wire protocol.

Custom scenarios requiring native cloud credentials declare `requiresNativeCloudAuthorization`; the shared runner authorizes against the real Backend after isolated Electron connects. Scenarios managing multiple device authorizations declare `requiresNativeCloudInspector` and pass the current `control` to the authorization fixture. Authorize after connection on initial launch and each new-device restart, never from `prepareApp` or `afterStop` while the native process is not running.

Protocol-independent text replies in model fixtures must reuse `writeLocalAssistantMessage` to emit complete Responses, Chat Completions, or Anthropic termination events for the current request. Do not reset the selected model to accommodate a fixture with a fixed protocol or attribute stream failures caused by malformed fixture SSE to the official runtime.

The shared model entry recognizes background predictions by native metadata or the complete prediction prompt before invoking ordinary scenario handlers, across Responses, Chat Completions, Anthropic, and the official Codex Responses path. Scenarios that explicitly own prediction behavior still handle it themselves. Prediction JSON uses the current wire protocol without advancing foreground counters or releasing held replies; historical keywords do not classify requests.

Nested Goal scenarios must forward the shared runner's model request context through every layer. Text replies after restoring a conversation still use the current request protocol. Held or interrupted text streams reuse `modelTextStream`, preserving the Responses commentary phase, existing release conditions, and incomplete responses on interruption without changing business assertions or user model selection.

The fourth `handleHttp` argument provides the shared `modelRequest` (protocol name and `reply(text)`), or `null` for non-model requests. Text-only custom scenarios reuse this routing and writer so they do not miss request paths for a valid selected model.

Write configuration that Codex caches, including model catalog overrides, in the scenario's `prepareApp` before launching the app and shared app-server. `human-interactions` declares `request_user_input_async` at this stage. Updating the configuration or deleting the disk cache in `verify` can leave the running process using the old catalog.

Windows CI runs desktop tests under a standard account. Compile the DingTalk protocol fixture into the workspace before switching accounts and pass it through `WEWORK_E2E_DWS_FIXTURE_BIN` for the stand-in scenarios to reuse, without relying on that account's Rust toolchain. Local runs without a prebuilt fixture still compile it during scenario preparation. This is protocol integration coverage; real DingTalk compatibility remains unverified.

On Windows native Core plugin confirmation failures, `native-plugin-decision-failed` retains only fixed stages, monotonic elapsed times and the enumerated button count. Stages distinguish window matching, button enumeration, name reads, InvokePattern reads and invocation, identifying the last completed step without recording dialog contents, button text or arbitrary child output. A missing button count is `null`, never zero. The original ten-second search and twelve-second process deadlines remain unchanged; these diagnostics do not prove that native clicking has been fixed.

## Shared Codex startup protection

MCP App source reads, catalogs, resources, tool calls, and retained sessions use the owning task's Agent Home. When an isolated app-server owns a thread, requests use that process's existing JSON-RPC stream. Requests queue until thread restoration completes; source reads continue while waiting for user input, preserving native responses and notification order. A stopping owner remains authoritative until its child is reaped. A source read that was never admitted before the channel closed waits for ownership release within its original RPC deadline, then resolves the owner again; it cannot switch to a shared process while ownership remains. Admitted requests, unknown outcomes, and tool calls are never replayed. Fixed waiting/release events record elapsed time without extending the deadline. Shared-process reads retain their existing preparation and dispatch budgets. Tool isolation, source-invocation checks, and plugin/connector authorization remain enforced. These child-process protocol tests use a synthetic service and do not certify an official runtime fix; real E2E failures continue to block merging.

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

Rich-text `fill` selects text through a native shortcut, then sends lines and native Enter events sequentially within one host call. The host installs one acknowledgement in the focused frame and waits for the target editor to finish each trusted Enter keyup before inserting the next line. The existing ten-second per-key deadline remains; no per-line paint frame is required. The acknowledgement supports iframes and Shadow DOM, removes its listener on completion, and reports cleanup failures without replacing an earlier input error. Empty lines, Chinese text, and normalized line endings are preserved. Passing multiline text directly to Chromium `insertText` can retain only its first line in structured editors. The existing Electron CI runs `editor-native-input.test.mjs` against the real description editor, comparing Markdown and paragraph structure with individual native input, including the 61-block structure of 31 paragraphs and their empty lines, plus multiline input inside iframes and Shadow DOM. Business E2E assertions and deadlines remain unchanged. The description editor mirrors external values during React commit so a delayed controlled-value echo cannot overwrite newer native edits. Native input diagnostics separately time acknowledgement setup, Enter commits, text insertion, key dispatch and cleanup, without recording input text.

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

### Diff preview CPU and workbench memory regressions

The diff preview uses Pierre virtualization. Keep line callbacks, render options, annotations and layout metrics stable; owner refreshes or replacement event handlers must not rebuild unchanged code DOM. Actual option, diff and annotation changes must still render. `FileChangesPatchDiff.test.tsx` checks node identity across repeated refreshes and cleanup on unmount with real Pierre instances.

Define workbench memoized callbacks in independent Hook lexical scopes instead of the Provider's large render scope. Otherwise callbacks whose dependencies change at different rates can retain historical task, lifecycle and work-list snapshots through their shared closures. `workbenchCallbackLifetime.test.tsx` triggers real GC through Inspector, uses weak references to verify snapshot collection and guards against defining `useCallback` directly in the Provider again.

Interpret CPU samples, HTML parsing duration and process memory separately. Shared memory samples retain the existing renderer JS heap readings, conversation cache counts and main-process `process.memoryUsage()` values in bytes; a different sampled main PID yields `null`. Keep these separate from physical footprint in KiB. Collection adds no main-process GC and changes neither sampling windows nor memory limits. A macOS memory failure still fails the job; independent Inspector checkpoints continue when build and object storage preparation succeeded and the job was not cancelled, preserving diagnostic coverage for other cases. Heap object sizes do not equal Activity Monitor process memory; one heap snapshot establishes retaining paths, not a memory growth rate. After persisting the original failure, the shared runner can collect a main-process heap summary through its PID- and isolated-profile-verified native Inspector. V8 snapshot GC occurs after the measurement window; budgets and failure outcomes remain unchanged. Summaries contain categories, shallow bytes and one strong root path, not dominator retained sizes. Raw heap data stays in test-driver memory and is never written or uploaded; snapshots over 128MiB and collection failures are explicitly unavailable. Keep analysis files local and never commit user traces or heap snapshots.

E2E operation windows also record browser long-task and long-animation-frame counts, total duration and maxima; `responsiveness` budgets can assert these measurements directly. Unsupported timings remain unavailable instead of passing as zero. Full workbench diagnostics retain the latest 32 attribution records and a dropped count per window in `rendererResponsiveness`, using only compiled asset names, function identifiers, browser enums and numbers, without full URLs, query parameters or page content. Per-command reports carry counters only; detailed records are not repeated with every command. Full attribution events also flow through the shared error collector as info records associated with capture IDs; truncating the diagnostic ring does not silently discard the original collected records. Duration metrics round each event up to whole milliseconds; detailed records retain the browser’s original precision. Each frame retains at most three slow-script details and reports `omittedSlowScripts`; slow-script counts and maxima cover every slow script in the frame, independently of that detail cap or ordering. Details prioritize longest duration, using forced-layout duration only to break ties, so shorter layout calls cannot displace the slowest JavaScript work.

Memory snapshots also read the application HTTP worker’s `process.memoryUsage()` byte counters and retain them as `appWorkerMemory` only after matching its PID against the native process tree. This read-only endpoint is enabled only in explicit E2E mode and returns no environment, arguments or heap contents. Unknown PIDs, invalid counters and collection failures must not become zero; collection triggers no GC.

Idle work polling negotiates on-demand model discovery with the registration ACK field `runtime_work_catalog_probe`. A new Backend accepts `catalog_probe` to check pending or unconfirmed work without claiming tasks or publishing a catalog; an empty queue still returns workspace cleanup intents. Candidate work triggers `runtime.runner.catalog`, followed by the existing authorization and atomic claim path. Pending assignments participate in the probe so a stale catalog cannot prevent discovery of newly configured models. Older Backends retain their existing polling behavior; reconnects renegotiate the capability, and the fix takes effect after the Backend upgrade. This conservative queue hint does not guarantee that a candidate is ultimately claimable.

Catalog probes and actual claims share current device authorization, routing/affinity, work schedule and execution-scope occupancy filters. Probes defer model-catalog availability checks; the hint grants no execution authority. Publishing the fresh catalog is followed by the existing atomic claim revalidation.

Browser login E2E reuses the desktop suite’s real Rust/Python Backend, MySQL, Redis and MinIO, including the Backend artifact already built by CI. Backend preparation precedes Vite startup, and HTTP/Socket.IO proxies target the isolated run’s ports. Existing login visibility assertions remain; the real `/api/users/me` response must be an unauthenticated 401. Connection failures and server errors cannot stand in for authentication results. Only the model service is substituted; unused Sites/Connector doubles are not started. Browser Backend logs are uploaded separately, and desktop sample counts do not prove browser collection coverage.

Playwright cases use the automatic fixture from `e2e/fixtures/collected-test`, reusing redacted `E2EErrorLog` journals and exact `DesktopErrorCollector` assertions. HTTP responses, connection failures, page exceptions, console errors and crashes retain their severity. Page closure precedes committed-write and contiguous-sequence checks and explicit error assertions. Browser mode reads the existing default preferences without invoking Electron-only preference APIs; Electron read failures remain errors. Browser mode does not start native event polling or tray synchronization. Skipping a socket connection before login is informational; actual connection and authentication failures remain errors. `errors.expectHttpError(response, status)` binds the real request ID; structured client HTTP errors additionally match the actual request’s `X-Request-ID` and status, with exactly one record per matched kind; at most one Chromium console record must match the same URL, actual status and reason exactly. Other expected failures use `errors.expectError(predicate, count)`; unmatched errors fail. Journals and assertion summaries are attached to Playwright reports. This does not prove coverage of external browser processes or every Worker.

Browser collection observes requests, responses, exceptions and console events at BrowserContext scope. Newly created pages and popups register crash, close and WebSocket observers. Each WebSocket receives its own connection ID for open, socketerror and close records; frame payloads are not recorded. Teardown closes the test context before acknowledging the journal checkpoint so closure events remain observable.

The first catalog publication is an explicit discovery demand: Backend probes request discovery when no valid `runnerCatalog` has been published, breaking the cycle in which task admission needs a catalog but discovery waits for queued work. A valid empty catalog counts as published and does not trigger repeated idle discovery. Subsequent candidate probes retain device policy checks and claim revalidation.

Model proxy request logs correlate request start and upstream headers with a local `request_id`. Header observations distinguish `client_build_ms` (HTTP client construction) from `upstream_wait_ms` (sending, waiting, and existing retries); total `elapsed_ms` also includes request adaptation and earlier work. These intervals do not equal upstream service processing time. Requests without response headers retain unknown phase timing rather than zero values.

Shared native RPC records `codex native request sent` after writing the request frame, with only the method, request ID, process generation, Executor PID, and write duration. It does not record parameters. Combine this boundary with caller start, native turn events, and structured failure identity to distinguish host waiting before the write from runtime waiting afterward. A written request does not establish execution or business success.

Stored conversation history reads and searches retain the transport proxy configuration gate in `requestLocalExecutor`. They do not wait for model catalog preparation, rewrite the catalog, or restart Codex to read history. Send and model actions still own model preparation; failed proxy configuration continues to block native reads and report the failure.

macOS process samples also retain `native_memory_categories` from the same native `footprint` read: dirty, swapped, clean, reclaimable and wired bytes plus region counts for heap allocations, code segments, stacks and other mappings. Only allowlisted system category labels survive; other labels merge into `other`. Process names, mapped paths and heap contents are excluded. Missing categories remain `null`, never zero. Category totals do not replace physical footprint or independently establish an object leak.

For missing macOS native physical-footprint values, collection checks OS process state. Disappeared descendants and confirmed `Z` zombies have no active address space; `exited_processes` (sample field `exitedProcesses`) records their fate without fabricating zero memory. A successful `kill(pid, 0)` alone does not establish a running process. Missing main-process values, missing live-descendant values and unavailable state still fail, with PID, parent PID, group, executable basename and state diagnostics only. Collection records no command arguments, substitutes no RSS and does not resample to obtain a pass.

MCP App requests reuse one thread-activity scope from source validation and cold-session restoration through tool dispatch. Automatic idle restart waits for that operation to finish, preserving source ownership between RPCs. The scope releases after completion or cancellation; an unknown dispatched outcome remains explicit and side-effecting tools are never automatically replayed.

Log drainage reuses the 10-second process-stop deadline to wait for source pipes to close. On expiry, it preserves received bytes, releases collector-owned readers, and fails explicitly with `ERR_PROCESS_OUTPUT_UNCLOSED`; a truncated log is incomplete and scenario success does not become a final pass. Managed child processes bind stdout/stderr together; both stream diagnostics include the owner PID, exit code, and signal to distinguish application exit from pipe EOF. Without evidence identifying the handle holder, the native runtime cause remains unverified.

Browser Playwright uses compiled assets. CI sets `WEWORK_E2E_PREBUILT_WEB_ARCHIVE` to reuse the UI from the same shared desktop build; local runs without an archive build the UI first. The launcher writes the real Backend addresses through the existing `runtime-config.js` and serves static assets at `/wework/app/`, avoiding Vite source-module transformation during assertions. The anonymous-session 401 is asserted on an explicit login-route request, followed by application-root redirection checks. These checks do not rely on repeated development StrictMode effects; existing behavioral assertions and deadlines remain.

The Windows native decision client and read-only window observer are precompiled during shared runner preparation into separate DLLs named by source digest. Native input only loads the prepared client instead of compiling C# inside the original 12-second input window. Missing artifacts still fail. UIA checks for PID, native handle, dialog class, button name, uniqueness, and invocation remain, and CI continues to verify Allow and Cancel with real Windows dialogs. Separate DLLs keep the failure observer independent of UIAutomation and input delivery.

In E2E mode, Executor records receipt and dispatch times for native `commandExecution` lifecycle notifications, native lifecycle timestamps and duration, thread/turn/item IDs, and process generation. Unavailable native timestamps remain null. Commands, directories, and output are excluded; notification dispatch time is not tool execution time. Before Windows shutdown, the runner retains an owned-process snapshot without labels or arguments. If pipe drainage fails, it queries creation times for only those PIDs and distinguishes absence from query failure. A live PID alone proves neither process identity nor pipe ownership.

Windows process-tree termination checks the `taskkill` exit code. Partial descendant termination fails with `ERR_WINDOWS_PROCESS_TREE_TERMINATION`, retaining the target PID and exit code, even if the parent has exited. This does not prove that a failed descendant holds a log handle; the independent output-drain gate still runs.

For source applications, the shared Windows desktop runner assigns the application to a native Job Object before its first instruction. Shutdown succeeds only when the owned job reports zero active processes; parent exit and PID disappearance are insufficient. The supervisor uses a separate entry in the existing Executor binary without changing the official runtime, application arguments, or business assertions. Lossless protocol frames separate application stderr from supervisor output under their actual PIDs. Supervisor observations reuse the same redacted error journal and retain a separate collection receipt; failed writes still fail verification. Native termination errors, invalid frames, and timeouts remain failures. The non-container path retains its nonzero taskkill gate, and output draining remains independently required.

A termination-command failure also records presence and creation times for the known owned PIDs immediately; a later drainage failure records another observation. The original error is rethrown without automatically retrying termination.

Private activity-source diagnostics record message ID, sequence, revision, source state, address presence, and lookup duration separately for initial snapshots, broadcasts, and targeted resolution. Obsolete revisions and inactive subscriptions remain observable. Message content, raw trace references, and Runtime addresses are excluded; permissions and stale-response guards are unchanged.

Wework forwards these safe fields through the message client diagnostic callback to the existing `reportE2EDiagnostic` channel, persisting info records in the shared journal. The debug-panel ring buffer is not the only evidence source.
