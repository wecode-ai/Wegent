import type {
  HostProcessProvider,
  ProcessDegradation,
  ProcessExplorerClient,
  ProcessSnapshot,
} from '../contract.js'
import {
  buildProcessSnapshot,
  type ElectronProcessMetric,
  type WindowProcessInfo,
} from '../core/build-snapshot.js'
import {
  describeError,
  type SystemProcessTable,
  type SystemProcessTableResult,
} from './system-process-table.js'

export interface ProcessExplorerServiceOptions {
  applicationPid: number
  applicationName?: string
  platform?: string
  metrics: () => readonly ElectronProcessMetric[]
  windows?: () => readonly WindowProcessInfo[]
  hostProcesses?: HostProcessProvider
  systemTable?: SystemProcessTable | null
  now?: () => number
  /**
   * Minimum spacing between `getAppMetrics()` calls. Electron reports CPU as an
   * average over the interval since the previous call, so concurrent consumers
   * must share one measurement window.
   */
  minimumSampleIntervalMs?: number
  /** Upper bound for one external process-table read. */
  systemTableTimeoutMs?: number
}

/**
 * Host-side owner of process collection. There is exactly one instance per
 * application, so CPU deltas and cached snapshots are shared by every
 * capability that needs them.
 */
export class ProcessExplorerService implements ProcessExplorerClient {
  private cached: ProcessSnapshot | null = null
  private lastCollectedAt = 0
  private inFlight: Promise<ProcessSnapshot> | null = null
  private pendingSystemTableRead: Promise<SystemProcessTableResult> | null = null

  constructor(private readonly options: ProcessExplorerServiceOptions) {}

  snapshot(): Promise<ProcessSnapshot> {
    const now = this.currentTime()
    const minimumInterval = this.options.minimumSampleIntervalMs ?? 1000
    if (this.cached && now - this.lastCollectedAt < minimumInterval) {
      return Promise.resolve(this.cached)
    }
    return this.collect(now)
  }

  private async collect(now: number): Promise<ProcessSnapshot> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.collectNow(now)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async collectNow(now: number): Promise<ProcessSnapshot> {
    const systemTable = this.options.systemTable ?? null
    const [system, metrics] = await Promise.all([
      this.readSystemTable(systemTable, this.options.systemTableTimeoutMs ?? 10_000),
      Promise.resolve().then(() => this.options.metrics()),
    ])

    const windows = readOptional(this.options.windows, 'renderer-labels-failed')
    const hostProcesses = await readOptionalAsync(
      this.options.hostProcesses,
      'host-process-provider-failed'
    )

    const snapshot = buildProcessSnapshot({
      capturedAt: now,
      platform: this.options.platform ?? process.platform,
      applicationPid: this.options.applicationPid,
      applicationName: this.options.applicationName,
      metrics,
      windows: windows.values,
      system: system.processes,
      hostProcesses: hostProcesses.values,
      degraded: [...system.degraded, ...windows.degraded, ...hostProcesses.degraded],
    })
    this.cached = snapshot
    this.lastCollectedAt = now
    return snapshot
  }

  private currentTime(): number {
    return (this.options.now ?? Date.now)()
  }

  private async readSystemTable(
    systemTable: SystemProcessTable | null,
    timeoutMs: number
  ): Promise<SystemProcessTableResult> {
    if (!systemTable) return { processes: [], degraded: [] }

    // A timed-out read is still using an external process. Keep it as the one
    // pending read so automatic refreshes cannot accumulate hung collectors.
    this.pendingSystemTableRead ??= Promise.resolve()
      .then(() => systemTable.read())
      .finally(() => {
        this.pendingSystemTableRead = null
      })

    try {
      return await withTimeout(
        this.pendingSystemTableRead,
        timeoutMs,
        'System process table read timed out'
      )
    } catch (error) {
      return {
        processes: [],
        degraded: [{ code: 'system-process-table-failed', detail: describeError(error) }],
      }
    }
  }
}

interface OptionalReadResult<Value> {
  values: readonly Value[]
  degraded: ProcessDegradation[]
}

function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string
): Promise<Value> {
  if (!(timeoutMs > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function readOptional<Value>(
  read: (() => readonly Value[]) | undefined,
  failureCode: ProcessDegradation['code']
): OptionalReadResult<Value> {
  if (!read) return { values: [], degraded: [] }
  try {
    return { values: read(), degraded: [] }
  } catch (error) {
    return { values: [], degraded: [{ code: failureCode, detail: describeError(error) }] }
  }
}

async function readOptionalAsync<Value>(
  read: (() => readonly Value[] | Promise<readonly Value[]>) | undefined,
  failureCode: ProcessDegradation['code']
): Promise<OptionalReadResult<Value>> {
  if (!read) return { values: [], degraded: [] }
  try {
    return { values: await read(), degraded: [] }
  } catch (error) {
    return { values: [], degraded: [{ code: failureCode, detail: describeError(error) }] }
  }
}
