# Process explorer design

This document is the design source of truth for the Process Explorer.

## Audience and job

The process explorer is a **developer and support tool** under
Help → Developer tools. It is not an end-user task-control surface.

Its job is to answer three questions about this WeWork instance:

1. **Attribution**: which window, local runtime, agent process, or Chromium
   helper is consuming CPU or memory?
2. **Leak/staleness**: is a runtime process old, orphaned, or unexpectedly
   still alive?
3. **Reporting**: can the current process state be copied for a bug report?

The explorer is read-only. End users recover from a stuck task through task
cancellation, retry, a full application restart, or the existing runtime
lifecycle paths. They should not be asked to interpret PIDs or terminate
individual processes.

## What WeWork actually runs

| Process                                                | Owner                          | Notes                                                                  |
| ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------- |
| Browser process                                        | Electron                       | the application itself                                                 |
| Main / workspace / popout / process-explorer renderers | Electron                       | the main renderer hosts several tabs, so process memory is not per-tab |
| Embedded browser renderers                             | Electron `WebContentsView`     | can be large; must be labelled, not anonymous                          |
| Core DSH runtime                                       | `coreDshPid`                   | injected as a host service                                             |
| Managed executor                                       | `executorPid`                  | injected as a host service                                             |
| Workbench runtimes                                     | `workbenchRuntimes`            | one per dynamic workbench tab, injected with its tab id                |
| Plugin development runtime                             | `developmentPlugin.coreDshPid` | injected when active                                                   |
| Codex app-server / Claude / task shells                | executor children              | shown as host children                                                 |
| GPU / utility services                                 | Electron                       | diagnosed only; no process action is offered                           |

Attribution limits:

- The main window's renderer hosts multiple workbench tabs. OS metrics cannot
  be split per tab; only independent workbench runtimes can be attributed by tab.
- A codex app-server's launch details contain its `CODEX_HOME`, not the task or
  workspace. Mapping a process to a task requires an executor RPC and is outside
  this surface.
- Orphaned runtimes from a previous launch are reparented and are not
  descendants of the current application. Detecting them requires a
  host-specific scan and is not part of this surface.

## Feature set

- A collapsible owner tree instead of a flat memory sort:
  Application / Windows / Local runtime / Chromium helpers / Other, with
  executor children nested under the executor.
- A compact toolbar with a name/PID/launch-detail filter, totals, and refresh.
- A selected-row footer that shows the full launch details, with a small icon
  to copy just that process detail; no full diagnostics export.
- Resizable columns with sensible defaults; dragging a header edge redistributes
  width to the neighbouring column and double-clicking resets the defaults.
- A window pin that keeps the explorer on top while another app is inspected.
- Runtime injection: core runtime, executor, workbench runtimes, plugin
  development runtime.
- Window labels for every renderer, including embedded browser views.
- Process age / start time, for leak and stale-process diagnosis.
- CPU, memory, PID, launch details, and a total summary.
- A degraded-state banner when the platform process table is unavailable.
- The existing menu entry and separate window.

The explorer does not expose a process table as a normal workbench page for end
users, and it does not promise a process-to-task mapping that the OS data cannot
provide.

## Decisions

- **Package**: `packages/process-explorer` is a **headless** package with two
  entry points:
  - `.` — contract and pure snapshot assembly
  - `./host` — Electron metrics plus cross-platform `systeminformation`
    collection
- **UI**: the React view lives in WeWork, not in the package. Owner grouping,
  labels, launch-detail formatting, i18n, and the design system are
  product-specific.
- **Platforms**: Electron metrics on every platform. `systeminformation`
  enriches the snapshot on its supported platforms; when it is unavailable the
  snapshot still renders Electron metrics and host injected processes.
- **Surface**: a separate window, created by the Wework host. It runs inside
  the same preferences and appearance providers as the main window, so language
  and light/dark mode follow without a second settings path.
- **Read-only**: no termination capability is exposed by the package, the host,
  or the renderer. Recovery is a full application restart, not a partial
  process kill.

## Build boundary

The renderer and the Electron host use separate pnpm projects.

- The renderer imports the package types through a tsconfig path. The runtime
  view lives in WeWork; there is no Vite alias and no package runtime import in
  the renderer bundle.
- The Electron project cannot depend on the root package without pulling the
  package's toolchain into its own workspace and having both installs write the
  same `node_modules`. `electron/scripts/stage-process-explorer.mjs` copies the
  contract, core, and host sources into a gitignored
  `electron/src/vendor/process-explorer` directory before `tsc`. The compiled
  output is self-contained in `dist/vendor`, so packaging does not need a
  workspace dependency.

## Ownership and diagnostics metadata

Every record carries an explicit owner supplied by the host:

```ts
interface ProcessOwnerRef {
  id: string // stable grouping key, e.g. 'executor' or 'workbench:task-1'
  label: string // host fallback label
  key?: string // optional i18n key for a known owner
}
```

Native Electron records get default owners (`application`, `windows`,
`helpers`, `other`). Injected descriptors must supply their owner, and their
descendants inherit it. The renderer never infers ownership from display names,
so adding a runtime only requires a host descriptor.

Host descriptors also accept a stable `identity` suffix for `ProcessRecord.id`.
Non-fatal collection gaps use structured `ProcessDegradation` codes instead of
raw strings.

The tree rows are focusable and select with Enter or Space. This keeps the
surface usable without a pointer.

## Data contract

```ts
type ProcessKind =
  | 'application'
  | 'window'
  | 'gpu'
  | 'utility'
  | 'zygote'
  | 'sandbox-helper'
  | 'pepper'
  | 'host-service'
  | 'host-child'
  | 'system'

interface ProcessRecord {
  id: string // `${pid}:${creationTime}`; never a bare pid
  pid: number
  parentPid: number | null
  kind: ProcessKind
  source: 'electron' | 'host' | 'system'
  owner: ProcessOwnerRef
  name: string
  detail: string | null // launch details or service name
  cpuPercent: number | null
  memoryBytes: number | null
  idleWakeupsPerSecond: number | null
  startedAt: number | null // epoch milliseconds
}

interface ProcessSnapshot {
  capturedAt: number
  platform: string
  applicationPid: number
  processes: ProcessRecord[]
  degraded: ProcessDegradation[] // structured, non-fatal gaps
}
```

`id` uses `pid + creationTime` because Electron documents pid reuse; it remains
useful for stable row identity and diagnostics even though nothing is ended.

## Collection

Priority order, highest first:

1. **Electron metrics** (`app.getAppMetrics()`): Chromium process type, name,
   service name, CPU, memory (kilobytes, converted to bytes), wakeups, creation
   time.
2. **Host injection**: descriptors for processes Electron does not manage. The
   descriptor supplies only identity and label; it never supplies permission.
3. **System table**: adds launch details, ancestry, start time, and processes
   Electron does not report, including descendants of injected roots. Collection
   is delegated to `systeminformation`, which owns the per-OS implementations
   (`ps` on Unix, CIM on Windows, and the other supported platforms) and CPU
   sampling. We only map its stable process shape into `SystemProcessInfo`.

Window labels come from every live `webContents`, not just `BrowserWindow`
instances, so embedded browser views are labelled through
`embeddedBrowser.labelForContentsId()`. A record that exists in both Electron
metrics and the system table uses Electron metrics for CPU and memory and the
system row only for metadata.

The adapter hides `systeminformation`'s own PowerShell collector process on
Windows so it does not appear as a WeWork-owned process.

## Injection interface

```ts
interface HostProcessDescriptor {
  pid: number
  name: string
  kind: 'host-service' | 'host-child'
  owner: ProcessOwnerRef
  identity?: string
  includeDescendants?: boolean
}

type HostProcessProvider = () => readonly HostProcessDescriptor[]
```

Wework injects the managed executor, the core runtime, each workbench runtime
with its tab id, and the plugin development runtime when active. Descendants of
an injected root inherit the root's owner. The host also supplies
`applicationName` (Electron's `app.getName()`) so the application row does not
fall back to the generic "Application" label.

## Read-only design

The explorer is read-only. It does not expose process termination or restart
actions:

- a renderer hang, the common failure, cannot be fixed because renderers are
  protected;
- Chromium utility processes include Network, Audio, and Storage services;
  ending one can leave WeWork looking alive while network or media is broken;
- a full application restart is deterministic and reuses the existing
  lifecycle instead of introducing a second recovery path.

The explorer therefore only collects and explains processes. Recovery actions
are not inferred from `ProcessKind`.

## Sampling

One `ProcessExplorerService` instance lives in the main process. It caches a
snapshot briefly and enforces a minimum interval between `getAppMetrics()` calls
(1000 ms), so concurrent consumers share one CPU measurement window. The
Process Explorer reads it through `diagnostics.processSnapshot`.

## Compatibility boundary with Performance Diagnostics

The existing Performance Diagnostics pipeline is intentionally unchanged. Its
`e2e.getProcessSnapshot` capability still calls the existing macOS `ps` collector
in `wework/electron/src/host/process-diagnostics.ts` and keeps the
`rss_kib` / `physical_footprint_kib` contract used by the memory E2E baselines.
The Process Explorer must not be routed through that endpoint.

The two surfaces therefore collect independently:

- Process Explorer uses Electron metrics plus `systeminformation`, and its
  memory column uses Electron `workingSetSize` for Electron-owned processes.
- Performance Diagnostics keeps OS `ps` RSS values on macOS.

Those values are close but not interchangeable. Changing Performance
Diagnostics to the new snapshot would require a deliberate memory-baseline
update; do not normalize the two pipelines incidentally.

## Test plan

- Package unit tests: kind mapping, `pid + creationTime` identity, injection
  override, descendant collection, systeminformation mapping, CPU normalization,
  start-time parsing, and service timeout/degradation handling.
- WeWork view tests: owner grouping, age formatting, launch-detail normalization,
  full selected-process detail display, selected-detail copy, column resizing,
  keyboard selection, degraded state, and no termination actions.
- Desktop E2E: open from the menu, verify the application row and Chromium
  helpers, filter, keyboard selection, collapse/expand, pin, detail copy,
  compact width, and inherited plus live language/theme changes. The
  process-explorer checkpoint runs in the shared core shards on Linux and
  Windows and is also verified locally on macOS.
