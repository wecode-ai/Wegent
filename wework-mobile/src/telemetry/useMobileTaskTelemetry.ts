import { useEffect, useRef } from 'react'
import { allWorkspaces } from '@/domain/work'
import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import type { DeviceInfo, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/runtime'
import { mobileTelemetry } from './mobileTelemetry'
import type {
  MobileExecutionTarget,
  MobileTelemetryFailureReason,
  MobileTelemetryResult,
} from './events'
import { takeMobileTaskOutcome } from './taskOutcome'

const RETRY_WINDOW_MS = 60_000
const COMPLETED_RETENTION_MS = 5 * 60_000
const MAX_OBSERVED_TASKS = 500

interface ObservedTask {
  running: boolean
  startedAt: number | null
  runCount: number
  lastCompletedAt: number | null
  lastResult: MobileTelemetryResult | null
}

export function useMobileTaskTelemetry({
  work,
  taskRunningByKey,
  devices,
}: {
  work: RuntimeWorkListResponse
  taskRunningByKey: ReadonlyMap<string, boolean>
  devices: DeviceInfo[]
}): void {
  const observed = useRef(new Map<string, ObservedTask>())

  useEffect(() => {
    const now = Date.now()
    const tasks = new Map<string, ReturnType<typeof workspaceTasks>[number]>()
    for (const workspace of allWorkspaces(work)) {
      for (const task of workspace.tasks) {
        tasks.set(runtimeTaskKey({ deviceId: workspace.deviceId, taskId: task.taskId }), task)
      }
    }
    const keys = new Set([...taskRunningByKey.keys(), ...observed.current.keys()])
    for (const key of keys) {
      const address = taskAddress(key)
      if (!address) continue
      const previous = observed.current.get(key)
      const nextRunning = taskRunningByKey.get(key) === true
      if (!previous && !nextRunning) continue
      const current: ObservedTask = previous ?? {
        running: false,
        startedAt: null,
        runCount: 0,
        lastCompletedAt: null,
        lastResult: null,
      }
      const target = executionTarget(address.deviceId, devices)
      if (!current.running && nextRunning) startTask(current, target, now)
      if (current.running && !nextRunning) {
        completeTask(current, address, tasks.get(key)?.status, target, now)
      }
      current.running = nextRunning
      observed.current.set(key, current)
    }
    pruneObserved(observed.current, now)
  }, [devices, taskRunningByKey, work])
}

function startTask(task: ObservedTask, target: MobileExecutionTarget, now: number): void {
  const runCount = task.runCount + 1
  task.runCount = runCount
  task.startedAt = now
  mobileTelemetry.track('mobile_task_started', {
    execution_target: target,
    run_count: runCount,
  })
  if (runCount < 2 || task.lastCompletedAt === null || task.lastResult === null) return
  const sinceLastMs = Math.max(0, now - task.lastCompletedAt)
  if (sinceLastMs > RETRY_WINDOW_MS) return
  mobileTelemetry.track('mobile_task_retried', {
    execution_target: target,
    previous_result: task.lastResult,
    since_last_ms: sinceLastMs,
  })
}

function completeTask(
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
  mobileTelemetry.track('mobile_task_completed', {
    duration_ms: durationMs,
    execution_target: target,
    result,
    ...(result === 'failure' && { failure_reason: failureReason(taskStatus) }),
    run_count: task.runCount,
  })
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
  if (device.device_type === 'local' || device.device_type === 'app') return 'local'
  return 'remote'
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

function pruneObserved(observed: Map<string, ObservedTask>, now: number): void {
  for (const [key, task] of observed) {
    if (
      !task.running &&
      task.lastCompletedAt !== null &&
      now - task.lastCompletedAt > COMPLETED_RETENTION_MS
    ) {
      observed.delete(key)
    }
    if (observed.size <= MAX_OBSERVED_TASKS) continue
    for (const [candidate, candidateTask] of observed) {
      if (observed.size <= MAX_OBSERVED_TASKS) break
      if (!candidateTask.running) observed.delete(candidate)
    }
  }
}

function workspaceTasks(work: RuntimeWorkListResponse) {
  return allWorkspaces(work).flatMap(workspace => workspace.tasks)
}
