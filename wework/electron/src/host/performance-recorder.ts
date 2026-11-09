import { cpus, freemem, totalmem } from 'node:os'
import { mem, type Systeminformation } from 'systeminformation'
import { RotatingLog } from '../runtime/rotating-log.js'
import type { ProcessRecord, ProcessSnapshot } from '../vendor/process-explorer/contract.js'
import { cpuLoadRatioBetween, cpuTimeSample, type CpuTimeSample } from './system-cpu.js'

const SAMPLE_INTERVAL_MS = 5000
const COLLECTION_TIMEOUT_MS = 10_000
const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_ENTRY_BYTES = 256 * 1024
const MAX_PROCESSES = 1000
const KNOWN_OWNERS = new Set([
  'application',
  'windows',
  'helpers',
  'core-runtime',
  'executor',
  'plugin-development',
  'other',
])

export interface PerformanceRecorderOptions {
  logPath: string
  appVersion: string
  processSnapshot: () => Promise<ProcessSnapshot>
}

/** Device-owned recording that survives a renderer crash or application restart. */
export class PerformanceRecorder {
  private enabled = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private lifecycle = Promise.resolve()
  private pendingProcesses: Promise<ProcessSnapshot> | null = null
  private pendingMemory: Promise<Systeminformation.MemData> | null = null
  private previousCpu: CpuTimeSample | null = null
  private previousWriteFailed = false
  private log: RotatingLog

  constructor(private readonly options: PerformanceRecorderOptions) {
    this.log = this.createLog()
  }

  setEnabled(enabled: boolean): Promise<void> {
    const operation = this.lifecycle.then(() => this.changeEnabled(enabled))
    this.lifecycle = operation.catch(() => undefined)
    return operation
  }

  stop(): Promise<void> {
    return this.setEnabled(false)
  }

  private async changeEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return
    if (enabled) {
      await this.write(this.metadata('recording-started'))
      this.previousCpu = cpuTimeSample()
      this.enabled = true
      this.startSample()
      return
    }
    this.enabled = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.inFlight
    await this.write(this.metadata('recording-stopped'))
    await this.log.flush()
  }

  private startSample(): void {
    if (!this.enabled || this.inFlight) return
    this.inFlight = this.recordSample()
      .catch(() => {
        console.warn('[Performance recording] Sample could not be written')
      })
      .finally(() => {
        this.inFlight = null
        if (!this.enabled) return
        this.timer = setTimeout(() => {
          this.timer = null
          this.startSample()
        }, SAMPLE_INTERVAL_MS)
        this.timer.unref?.()
      })
  }

  private async recordSample(): Promise<void> {
    const [processes, memory] = await Promise.allSettled([this.readProcesses(), this.readMemory()])
    const cpu = cpuTimeSample()
    const memoryData = memory.status === 'fulfilled' ? memory.value : null
    const snapshot = processes.status === 'fulfilled' ? processes.value : null
    const degraded: string[] = snapshot?.degraded.map(value => value.code) ?? []
    if (processes.status === 'rejected') degraded.push('process-snapshot-failed')
    if (memory.status === 'rejected') degraded.push('system-memory-failed')
    if (this.previousWriteFailed) degraded.push('previous-log-write-failed')
    const sample = {
      ...this.metadata('performance-sample'),
      applicationPid: snapshot?.applicationPid ?? process.pid,
      processSnapshotCapturedAt: snapshot?.capturedAt ?? null,
      system: {
        cpuPercent: this.previousCpu ? cpuLoadRatioBetween(this.previousCpu, cpu) * 100 : null,
        cpuCount: cpus().length,
        memoryTotalBytes: memoryData?.total ?? totalmem(),
        memoryFreeBytes: memoryData?.free ?? freemem(),
        memoryAvailableBytes: memoryData?.available ?? freemem(),
        memoryActiveBytes: memoryData?.active ?? null,
        swapTotalBytes: memoryData?.swaptotal ?? null,
        swapUsedBytes: memoryData?.swapused ?? null,
        swapFreeBytes: memoryData?.swapfree ?? null,
      },
      processCount: snapshot?.processes.length ?? 0,
      omittedProcessCount: 0,
      degraded,
      processes: (snapshot?.processes ?? []).slice(0, MAX_PROCESSES).map(projectProcess),
    }
    this.previousCpu = cpu
    sample.omittedProcessCount = sample.processCount - sample.processes.length
    let contents = JSON.stringify(sample)
    while (Buffer.byteLength(contents) > MAX_ENTRY_BYTES - 128 && sample.processes.length) {
      sample.processes.pop()
      sample.omittedProcessCount += 1
      contents = JSON.stringify(sample)
    }
    await this.write(contents)
  }

  private readProcesses(): Promise<ProcessSnapshot> {
    this.pendingProcesses ??= withCollectionTimeout(
      Promise.resolve()
        .then(this.options.processSnapshot)
        .finally(() => {
          this.pendingProcesses = null
        })
    )
    return this.pendingProcesses
  }

  private readMemory(): Promise<Systeminformation.MemData> {
    this.pendingMemory ??= withCollectionTimeout(
      Promise.resolve()
        .then(() => mem())
        .finally(() => {
          this.pendingMemory = null
        })
    )
    return this.pendingMemory
  }

  private metadata(type: string) {
    return {
      schemaVersion: 1,
      type,
      timestamp: Date.now(),
      appVersion: this.options.appVersion,
      platform: process.platform,
      arch: process.arch,
      applicationPid: process.pid,
    }
  }

  private async write(value: string | ReturnType<PerformanceRecorder['metadata']>): Promise<void> {
    try {
      await this.log.write('supervisor', typeof value === 'string' ? value : JSON.stringify(value))
      this.previousWriteFailed = false
    } catch (error) {
      this.previousWriteFailed = true
      // RotatingLog serializes writes; a rejected queue must not poison later samples.
      this.log = this.createLog()
      throw error
    }
  }

  private createLog(): RotatingLog {
    return new RotatingLog({
      path: this.options.logPath,
      maxBytes: MAX_LOG_BYTES,
      maxEntryBytes: MAX_ENTRY_BYTES,
      retainedFiles: 3,
    })
  }
}

function projectProcess(record: ProcessRecord) {
  const owner = record.owner.id.startsWith('workbench:')
    ? 'workbench'
    : KNOWN_OWNERS.has(record.owner.key ?? '')
      ? record.owner.key!
      : 'other'
  return {
    pid: record.pid,
    parentPid: record.parentPid,
    kind: record.kind,
    source: record.source,
    owner,
    executableName: executableName(record),
    cpuPercent: record.cpuPercent,
    memoryBytes: record.memoryBytes,
    startedAt: record.startedAt,
  }
}

function executableName(record: ProcessRecord): string | null {
  if (record.source !== 'system' || record.kind === 'window') return null
  const name = record.name.split(/[\\/]/).at(-1) ?? ''
  return /^[A-Za-z0-9._+-]{1,80}$/.test(name) ? name : null
}

function withCollectionTimeout<Value>(pending: Promise<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Performance collection timed out')),
      COLLECTION_TIMEOUT_MS
    )
    timer.unref?.()
    pending.then(
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
