import type {
  HostProcessProvider,
  ProcessDegradation,
  ProcessExplorerClient,
  ProcessSnapshot,
  ProcessSnapshotOptions,
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
  private inFlight = new Map<SystemProcessTableResult | null, Promise<ProcessSnapshot>>()
  private pendingSystemTableRead: Promise<SystemProcessTableResult> | null = null
  private boundedSystemTableRead: Promise<SystemProcessTableResult> | null = null
  private systemTableResult: SystemProcessTableResult | null = null
  private systemTableRefresh: Promise<void> | null = null
  private cachedMetrics: readonly ElectronProcessMetric[] | null = null
  private lastMetricsAt = 0

  constructor(private readonly options: ProcessExplorerServiceOptions) {}

  async snapshot(options: ProcessSnapshotOptions = {}): Promise<ProcessSnapshot> {
    const now = this.currentTime()
    const minimumInterval = this.options.minimumSampleIntervalMs ?? 1000
    const complete = options.waitForSystemProcesses !== false
    if (
      this.cached &&
      now - this.lastCollectedAt < minimumInterval &&
      (!complete || (!this.systemTableRefresh && !this.cached.collectingSystemProcesses))
    ) {
      return this.cached
    }
    const refresh = this.refreshSystemTable(this.options.systemTable ?? null)
    if (complete) await refresh
    return this.collect(this.currentTime(), this.systemTableResult)
  }

  private async collect(
    now: number,
    system: SystemProcessTableResult | null
  ): Promise<ProcessSnapshot> {
    const active = this.inFlight.get(system)
    if (active) return active
    const pending = this.collectNow(now, system)
    this.inFlight.set(system, pending)
    try {
      return await pending
    } finally {
      if (this.inFlight.get(system) === pending) this.inFlight.delete(system)
    }
  }

  private async collectNow(
    now: number,
    system: SystemProcessTableResult | null
  ): Promise<ProcessSnapshot> {
    const systemTable = this.options.systemTable ?? null
    const minimumInterval = this.options.minimumSampleIntervalMs ?? 1000
    if (!this.cachedMetrics || now - this.lastMetricsAt >= minimumInterval) {
      this.cachedMetrics = this.options.metrics()
      this.lastMetricsAt = now
    }
    const metrics = this.cachedMetrics

    const windows = readOptional(this.options.windows, 'renderer-labels-failed')
    const hostProcesses = await readOptionalAsync(
      this.options.hostProcesses,
      'host-process-provider-failed'
    )

    const data = system ?? { processes: [], degraded: [] }
    const snapshot = buildProcessSnapshot({
      capturedAt: now,
      platform: this.options.platform ?? process.platform,
      applicationPid: this.options.applicationPid,
      applicationName: this.options.applicationName,
      metrics,
      windows: windows.values,
      system: data.processes,
      hostProcesses: hostProcesses.values,
      degraded: [...data.degraded, ...windows.degraded, ...hostProcesses.degraded],
    })
    snapshot.collectingSystemProcesses = Boolean(systemTable && !system)
    // A slower preview must not replace a completed table's cached snapshot.
    if (system === this.systemTableResult) {
      this.cached = snapshot
      this.lastCollectedAt = now
    }
    return snapshot
  }

  private currentTime(): number {
    return (this.options.now ?? Date.now)()
  }

  private refreshSystemTable(systemTable: SystemProcessTable | null): Promise<void> {
    if (!systemTable) return Promise.resolve()
    if (this.systemTableRefresh) return this.systemTableRefresh
    // Electron owns its metrics. External process enumeration supplements them
    // asynchronously and must not hide the application's available processes.
    this.systemTableRefresh = this.readSystemTable(
      systemTable,
      this.options.systemTableTimeoutMs ?? 10_000
    )
      .then(result => {
        this.systemTableResult = result
        this.lastCollectedAt = Number.NEGATIVE_INFINITY
      })
      .finally(() => {
        this.systemTableRefresh = null
      })
    return this.systemTableRefresh
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
        this.boundedSystemTableRead = null
      })

    // Reuse the timeout result until the raw read settles, so later samples do
    // not attach more waiters or timers to the same hung process collector.
    this.boundedSystemTableRead ??= withTimeout(
      this.pendingSystemTableRead,
      timeoutMs,
      'System process table read timed out'
    ).catch(error => ({
      processes: [],
      degraded: [{ code: 'system-process-table-failed', detail: describeError(error) }],
    }))
    return this.boundedSystemTableRead
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
