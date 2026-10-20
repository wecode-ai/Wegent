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
