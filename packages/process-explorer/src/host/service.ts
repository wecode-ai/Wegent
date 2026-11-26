import type {
  ExitedProcessRecord,
  HostProcessProvider,
  ProcessDegradation,
  ProcessExplorerClient,
  ProcessRecord,
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
  /** How long an exited process stays in `recentlyExited`. */
  exitedLingerMs?: number
}

const DEFAULT_EXITED_LINGER_MS = 5000

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
  private readonly recentlyExited = new Map<string, ExitedProcessRecord>()
  /**
   * Live child pid to its exited parent, pruned with the parent. The child's
   * identity is kept so a reused pid is never reparented.
   */
  private readonly reparentedChildren = new Map<number, { parentPid: number; identity: string }>()
  /** When the cached system table was read; previews reuse it until the next read. */
  private systemTableReadAt = 0
  private collectSequence = 0
  private completeSequence = 0
  private lastCompleteReadAt = 0
  private lastComplete: ProcessSnapshot | null = null

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
    // Captured before the first await: a slower collection that resumes after a
    // newer one must not write exit state from its older table.
    const sequence = ++this.collectSequence
    const tableReadAt = this.systemTableReadAt
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
    const assemble = (recentlyExited: readonly ExitedProcessRecord[]) =>
      buildProcessSnapshot({
        capturedAt: now,
        platform: this.options.platform ?? process.platform,
        applicationPid: this.options.applicationPid,
        applicationName: this.options.applicationName,
        metrics,
        windows: windows.values,
        system: data.processes,
        hostProcesses: hostProcesses.values,
        recentlyExited,
        reparentedChildren: this.reparentedChildren,
        degraded: [...data.degraded, ...windows.degraded, ...hostProcesses.degraded],
      })
    const lingering = this.pruneExited(now)
    let snapshot = assemble([...lingering.values()])
    const exits = this.recordExits(snapshot, system, hostProcesses.degraded.length === 0, {
      sequence,
      tableReadAt,
      now,
    })
    // Children orphaned by this exit need it to stay in its tree.
    if (exits.records.length > 0) snapshot = assemble([...lingering.values(), ...exits.records])
    if (exits.complete) {
      this.lastComplete = snapshot
      this.lastCompleteReadAt = tableReadAt
      this.completeSequence = sequence
    }
    snapshot.recentlyExited = [...this.recentlyExited.values()]
    snapshot.collectingSystemProcesses = Boolean(systemTable && !system)
    // A slower preview must not replace a completed table's cached snapshot.
    if (system === this.systemTableResult) {
      this.cached = snapshot
      this.lastCollectedAt = now
    }
    return snapshot
  }

  /**
   * Marks processes missing between two complete observations as exited. A
   * preview built from a reused table, a failed table or host-metadata read, a
   * sampling gap longer than the linger window, or a collection superseded by a
   * newer one cannot prove an exit, so they change nothing.
   */
  private recordExits(
    snapshot: ProcessSnapshot,
    system: SystemProcessTableResult | null,
    hostMetadataReadable: boolean,
    observation: { sequence: number; tableReadAt: number; now: number }
  ): { complete: boolean; records: ExitedProcessRecord[] } {
    const exited: ExitedProcessRecord[] = []
    const complete =
      observation.sequence >= this.completeSequence &&
      hostMetadataReadable &&
      system !== null &&
      !system.degraded.some(item => item.code.startsWith('system-process-table'))
    if (!complete) return { complete, records: exited }
    const previous = this.lastComplete
    // Gaps are measured between table reads. A preview that reuses an old table
    // must not renew the baseline and hide everything that exited meanwhile.
    if (previous && observation.tableReadAt - this.lastCompleteReadAt <= this.exitedLingerMs()) {
      // A host descriptor and its OS row share a pid but not an identity, and a
      // process the OS reparented to launchd is alive but outside the tree, so
      // liveness also accepts a table row with the same pid and start time.
      const live = new Set(snapshot.processes.map(record => record.id))
      const startedByPid = new Map<number, number | null>()
      for (const row of system?.processes ?? []) {
        live.add(`${row.pid}:${row.identity}`)
        startedByPid.set(row.pid, row.startedAt)
      }
      const isLive = (record: ProcessRecord) =>
        live.has(record.id) ||
        (record.startedAt !== null && startedByPid.get(record.pid) === record.startedAt)
      for (const record of previous.processes) {
        if (isLive(record)) continue
        const exitedRecord = { ...record, exitedAt: observation.now }
        this.recentlyExited.set(record.id, exitedRecord)
        exited.push(exitedRecord)
      }
      // The OS reparents a live child to launchd when its parent exits. Keep
      // the last known parent so the child stays under the lingering row.
      const exitedPids = new Set(exited.map(record => record.pid))
      for (const record of previous.processes) {
        if (!isLive(record) || record.parentPid === null || !exitedPids.has(record.parentPid)) {
          continue
        }
        this.reparentedChildren.set(record.pid, {
          parentPid: record.parentPid,
          identity: record.id.slice(record.id.indexOf(':') + 1),
        })
      }
    }
    return { complete, records: exited }
  }

  private pruneExited(now: number): Map<number, ExitedProcessRecord> {
    const byPid = new Map<number, ExitedProcessRecord>()
    for (const [id, record] of this.recentlyExited) {
      if (now - record.exitedAt > this.exitedLingerMs()) this.recentlyExited.delete(id)
      else byPid.set(record.pid, record)
    }
    for (const [child, entry] of this.reparentedChildren) {
      if (!byPid.has(entry.parentPid)) this.reparentedChildren.delete(child)
    }
    return byPid
  }

  private exitedLingerMs(): number {
    return this.options.exitedLingerMs ?? DEFAULT_EXITED_LINGER_MS
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
        this.systemTableReadAt = this.currentTime()
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
