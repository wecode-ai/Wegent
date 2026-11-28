import type {
  DeviceInfo,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/runtime'
import { allWorkspaces } from '@/domain/work'
import { projectedRuntimeTaskRunning, runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import type {
  MobileAnalyticsEventMap,
  MobileAnalyticsEventName,
  MobileExecutionTarget,
  MobileTelemetryFailureReason,
  MobileTelemetryResult,
} from './events'
import { consumeMobileTaskAddressRenames } from './taskIdentity'
import { takeMobileTaskOutcome } from './taskOutcome'

const RETRY_WINDOW_MS = 60_000
const COMPLETED_RETENTION_MS = 5 * 60_000
const MAX_OBSERVED_TASKS = 500

export type MobileTaskTelemetryTracker = <EventName extends MobileAnalyticsEventName>(
  name: EventName,
  properties: MobileAnalyticsEventMap[EventName]
) => void

interface ObservedTask {
  running: boolean
  startedAt: number | null
  runCount: number
  lastCompletedAt: number | null
  lastResult: MobileTelemetryResult | null
}

export class MobileTaskTelemetryObserver {
  private readonly observed = new Map<string, ObservedTask>()

  constructor(private readonly track: MobileTaskTelemetryTracker) {}

  observe({
    work,
    taskRunningByKey,
    devices,
    now = Date.now(),
  }: {
    work: RuntimeWorkListResponse
    taskRunningByKey: ReadonlyMap<string, boolean>
    devices: DeviceInfo[]
    now?: number
  }): void {
    this.applyAddressRenames()
    const tasks = taskMap(work)
    const keys = new Set<string>([
      ...taskRunningByKey.keys(),
      ...tasks
        .entries()
        .filter(([, task]) => task.running === true)
        .map(([key]) => key),
      ...this.observed.keys(),
    ])
    for (const key of keys) {
      const address = taskAddress(key)
      if (!address) continue
      const previous = this.observed.get(key)
      const task = tasks.get(key)
      const projected = taskRunningByKey.get(key)
      const taskInScope = task !== undefined || typeof projected === 'boolean'
      if (!previous && !taskInScope) continue
      if (previous && !taskInScope) continue
      const nextRunning = projectedRuntimeTaskRunning(task, projected)
      const current: ObservedTask = previous ?? {
        running: false,
        startedAt: null,
        runCount: 0,
        lastCompletedAt: null,
        lastResult: null,
      }
      const target = executionTarget(address.deviceId, devices)
      if (!current.running && nextRunning) {
        this.startTask(current, address, target, now, typeof projected !== 'boolean')
      }
      if (current.running && !nextRunning) {
        this.completeTask(current, address, task?.status, target, now)
      }
      current.running = nextRunning
      this.observed.set(key, current)
    }
    this.pruneObserved(now)
  }

  private applyAddressRenames(): void {
    for (const [nextKey, previousKey] of consumeMobileTaskAddressRenames()) {
      const previous = this.observed.get(previousKey)
      if (!previous) continue
      this.observed.delete(previousKey)
      this.observed.set(nextKey, previous)
    }
  }

  private startTask(
    task: ObservedTask,
    address: RuntimeTaskAddress,
    target: MobileExecutionTarget,
    now: number,
    discardStaleOutcome: boolean
  ): void {
    if (discardStaleOutcome) takeMobileTaskOutcome(address)
    const runCount = task.runCount + 1
    task.runCount = runCount
    task.startedAt = now
    this.track('mobile_task_started', {
      execution_target: target,
      run_count: runCount,
    })
    if (runCount < 2 || task.lastCompletedAt === null || task.lastResult === null) return
    const sinceLastMs = Math.max(0, now - task.lastCompletedAt)
    if (sinceLastMs > RETRY_WINDOW_MS) return
    this.track('mobile_task_retried', {
      execution_target: target,
      previous_result: task.lastResult,
      since_last_ms: sinceLastMs,
    })
  }

  private completeTask(
    task: ObservedTask,
    address: RuntimeTaskAddress,
    taskStatus: string | null | undefined,
    target: MobileExecutionTarget,
    now: number
  ): void {
    const result = takeMobileTaskOutcome(address) ?? resultFromStatus(taskStatus)
    const durationMs = task.startedAt === null ? 0 : Math.max(0, now - task.startedAt)
    task.lastCompletedAt = now
    task.lastResult = result
    this.track('mobile_task_completed', {
      duration_ms: durationMs,
      execution_target: target,
      result,
      ...(result === 'failure' && { failure_reason: failureReason(taskStatus) }),
      run_count: task.runCount,
    })
  }

  private pruneObserved(now: number): void {
    for (const [key, task] of this.observed) {
      if (
        !task.running &&
        task.lastCompletedAt !== null &&
        now - task.lastCompletedAt > COMPLETED_RETENTION_MS
      ) {
        this.observed.delete(key)
      }
      if (this.observed.size <= MAX_OBSERVED_TASKS) continue
      for (const [candidate, candidateTask] of this.observed) {
        if (this.observed.size <= MAX_OBSERVED_TASKS) break
        if (!candidateTask.running) this.observed.delete(candidate)
      }
    }
  }
}

function taskMap(work: RuntimeWorkListResponse): Map<string, RuntimeTaskSummary> {
  const tasks = new Map<string, RuntimeTaskSummary>()
  for (const workspace of allWorkspaces(work)) {
    for (const task of workspace.tasks) {
      tasks.set(runtimeTaskKey({ deviceId: workspace.deviceId, taskId: task.taskId }), task)
    }
  }
  return tasks
}

function taskAddress(key: string): RuntimeTaskAddress | null {
  try {
    const value: unknown = JSON.parse(key)
    if (!Array.isArray(value) || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
      return null
    }
    return { deviceId: value[0], taskId: value[1], runtime: 'codex' }
  } catch {
    return null
  }
}

function executionTarget(deviceId: string, devices: DeviceInfo[]): MobileExecutionTarget {
  const device = devices.find(candidate => candidate.device_id === deviceId)
  if (!device) return 'unknown'
  return device.device_type === 'local' ? 'local' : 'remote'
}

function resultFromStatus(status: string | null | undefined): MobileTelemetryResult {
  const normalized = status?.toLowerCase() ?? ''
  if (normalized.includes('cancel')) return 'cancelled'
  if (normalized.includes('fail') || normalized.includes('error')) return 'failure'
  return 'success'
}

function failureReason(status: string | null | undefined): MobileTelemetryFailureReason {
  const normalized = status?.toLowerCase() ?? ''
  if (normalized.includes('network') || normalized.includes('connection')) return 'network_error'
  if (normalized.includes('model') || normalized.includes('provider')) return 'model_error'
  return normalized ? 'runtime_error' : 'unknown'
}
