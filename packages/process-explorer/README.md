# @wegent/process-explorer

A small, headless process collection core for Electron applications. The host
owns collection; an application renders its own view. The explorer is
read-only: it never terminates processes.

## Entry points

| Entry                           | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `@wegent/process-explorer`      | Contract types and snapshot assembly                         |
| `@wegent/process-explorer/host` | Electron metrics adapter, system process table, host service |

The package has no runtime dependency on Electron. `createElectronMetricsSource`
takes the embedding app's object structurally, so tests can pass plain values.
OS process collection is delegated to
[`systeminformation`](https://www.npmjs.com/package/systeminformation), which
owns the platform-specific implementations.

## Host

```ts
import { app, webContents } from 'electron'
import {
  ProcessExplorerService,
  createElectronMetricsSource,
  createSystemProcessTable,
  readRendererProcesses,
} from '@wegent/process-explorer/host'

const service = new ProcessExplorerService({
  applicationPid: process.pid,
  ...createElectronMetricsSource({
    applicationPid: process.pid,
    metrics: app,
    windows: () => readRendererProcesses(webContents.getAllWebContents()),
  }),
  systemTable: createSystemProcessTable(),
  hostProcesses: () => [
    {
      pid: executorPid,
      name: 'Executor',
      kind: 'host-service',
      owner: { id: 'executor', label: 'Executor', key: 'executor' },
      identity: 'executor',
    },
  ],
})

await service.snapshot()
```

- Electron metrics are the primary source; the system table only adds launch
  details, ancestry, start time, and processes Electron does not report.
- Host descriptors supply labels and stable identity only.
- `snapshot()` caches briefly and shares one CPU measurement window across
  concurrent consumers.

## Rendering

The application owns its view. It reads `ProcessSnapshot` and groups records by
its own product objects. There is no termination API.

## Collection lifecycle

Constructing the service does not start collection or a polling timer. Call
`snapshot()` to collect data; the embedding application owns refresh scheduling.
The default minimum sample interval is 1000 ms, and concurrent calls share an
in-flight collection. External process-table reads time out after 10 seconds
by default. A timed-out read remains shared until it settles, preventing later
refreshes from accumulating collectors. Collection gaps are reported through
structured `degraded` entries.

Host descriptors supply explicit owners; descendants of roots marked with
`includeDescendants` inherit those owners. The package does not infer task
ownership or discover orphaned processes outside the application and injected
root process trees.

## Wework integration

Wework's renderer imports the contract types through its TypeScript path
mapping. Its Electron host uses a separate pnpm project:
`wework/electron/scripts/stage-process-explorer.mjs` copies the contract, core,
and host sources into the ignored `electron/src/vendor/process-explorer`
directory before compilation. The compiled files are packaged under
`dist/vendor`; edit the package sources rather than the staged copies.

The existing Performance Diagnostics collector remains separate. It uses the
macOS `ps` RSS and `physical_footprint_kib` contract for memory E2E baselines,
while this explorer uses Electron `workingSetSize` for Electron-owned processes
and system-table RSS for other processes. These measurements are not
interchangeable; see the
[performance diagnostics guide](../../docs/en/wework/developer-guide/wework-performance-diagnostics.md).
