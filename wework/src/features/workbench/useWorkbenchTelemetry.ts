import { useEffect, useRef } from 'react'
import type { DeviceInfo, ProjectWithTasks, RuntimeTaskSummary } from '@/types/api'
import type { RuntimeTaskLifecycleStoreSnapshot } from './runtimeTaskLifecycle'
import type { ExecutionTarget, TelemetryFailureReason, TelemetryResult } from '@/telemetry/events'
import { track } from '@/telemetry/client'
import {
  activeRuntimeRunTraceId,
  mintRuntimeRunTraceId,
  settleRuntimeRunTraceId,
} from '@/telemetry/traceId'
import { peekGenerationOutcome, takeGenerationOutcome } from './runtimeGenerationOutcome'

interface WorkbenchTelemetryInput {
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  lifecycle: RuntimeTaskLifecycleStoreSnapshot
}

interface ObservedTask {
  firstResponseRecorded: boolean
  running: boolean
  startedAt: number | null
  turnActive: boolean
  stopping: boolean
  runCount: number
  lastCompletedAt: number | null
  lastResult: TelemetryResult | null
}

// Re-running the same task within this window counts as a retry rather than a
// fresh interaction, signaling impatience or a failing flow.
const TASK_RETRY_WINDOW_MS = 60_000

function executionTarget(deviceId: string, devices: DeviceInfo[]): ExecutionTarget {
  const device = devices.find(item => item.device_id === deviceId)
  if (device?.device_type === 'local' || device?.device_type === 'app') return 'local'
  if (device?.device_type === 'cloud' || device?.device_type === 'remote') return 'cloud'
  return deviceId === 'local-device' ? 'local' : 'unknown'
}

function taskResult(task: RuntimeTaskSummary | null): TelemetryResult {
  if (task?.turnStatus === 'interrupted' || task?.status === 'cancelled') return 'cancelled'
  if (task?.error || task?.turnStatus === 'failed' || task?.threadStatus === 'systemError') {
    return 'failure'
  }
  return 'success'
}

function failureReason(task: RuntimeTaskSummary | null): TelemetryFailureReason | undefined {
  if (taskResult(task) !== 'failure') return undefined
  const error = task?.error?.toLowerCase() ?? ''
  if (error.includes('network') || error.includes('connection')) return 'network_error'
  if (error.includes('model') || error.includes('provider')) return 'model_error'
  return error ? 'runtime_error' : 'unknown'
}

function projectSource(project: ProjectWithTasks): 'local' | 'cloud' | 'unknown' {
  const source = project.config?.workspace?.source
  if (source === 'local_path' || source === 'git') return 'local'
  return 'unknown'
}

export function useWorkbenchTelemetry({
  currentProject,
  devices,
  lifecycle,
}: WorkbenchTelemetryInput): void {
  const projectIdRef = useRef<number | null>(null)
  const tasksRef = useRef(new Map<string, ObservedTask>())
  const lifecycleRef = useRef(lifecycle)
  const devicesRef = useRef(devices)

  useEffect(() => {
    if (!currentProject || projectIdRef.current === currentProject.id) return
    projectIdRef.current = currentProject.id
    track('project_opened', { source: projectSource(currentProject) })
  }, [currentProject])

  useEffect(() => {
    lifecycleRef.current = lifecycle
    devicesRef.current = devices
    lifecycle.tasks.forEach((snapshot, key) => {
      const previous = tasksRef.current.get(key)
      const nextRunning = snapshot.derived.isRunning
      const nextTurnActive = snapshot.derived.isTurnActive
      const nextStopping = snapshot.execution.phase === 'stopping'
      // Skip tasks whose lifecycle flags are unchanged: no transition can fire
      // so nothing needs tracking, and skipping avoids allocating an updated
      // ObservedTask for every idle task on every store publish.
      if (
        previous &&
        previous.running === nextRunning &&
        previous.turnActive === nextTurnActive &&
        previous.stopping === nextStopping
      ) {
        return
      }
      const target = executionTarget(snapshot.address.deviceId, devices)
      const current: ObservedTask = previous ?? {
        firstResponseRecorded: false,
        running: false,
        startedAt: null,
        turnActive: false,
        stopping: false,
        runCount: 0,
        lastCompletedAt: null,
        lastResult: null,
      }

      if (!current.running && snapshot.derived.isRunning) {
        const now = Date.now()
        const runCount = current.runCount + 1
        current.runCount = runCount
        current.startedAt = now
        track('task_started', { execution_target: target })
        if (runCount >= 2) {
          track('generation_regenerated', {
            execution_target: target,
            turn_count: runCount,
          })
        }
        if (
          current.lastCompletedAt != null &&
          now - current.lastCompletedAt <= TASK_RETRY_WINDOW_MS
        ) {
          track('task_retried', {
            execution_target: target,
            since_last_ms: now - current.lastCompletedAt,
            ...(current.lastResult && { previous_result: current.lastResult }),
          })
        }
        track('$ai_trace', {
          $ai_trace_id: mintRuntimeRunTraceId(snapshot.address),
          $ai_trace_phase: 'start',
          execution_target: target,
        })
      }
      if (!current.stopping && snapshot.execution.phase === 'stopping') {
        track('task_interrupted', {
          execution_target: target,
          after_first_response: current.firstResponseRecorded,
          ...(current.startedAt != null && {
            duration_ms: Math.max(0, Date.now() - current.startedAt),
          }),
        })
      }
      if (current.turnActive && !snapshot.derived.isTurnActive && !current.firstResponseRecorded) {
        current.firstResponseRecorded = true
        track('first_response_completed', {
          duration_ms: Math.max(0, Date.now() - (current.startedAt ?? Date.now())),
          execution_target: target,
          result: peekGenerationOutcome(snapshot.address) ?? taskResult(snapshot.task),
        })
      }
      if (current.running && !snapshot.derived.isRunning) {
        const now = Date.now()
        const result = takeGenerationOutcome(snapshot.address) ?? taskResult(snapshot.task)
        const durationMs = current.startedAt != null ? Math.max(0, now - current.startedAt) : 0
        current.lastCompletedAt = now
        current.lastResult = result
        track('task_completed', {
          duration_ms: durationMs,
          execution_target: target,
          result,
          ...(result === 'failure' && { failure_reason: failureReason(snapshot.task) }),
        })
        const traceId = activeRuntimeRunTraceId(snapshot.address)
        if (traceId) {
          track('$ai_trace', {
            $ai_trace_id: traceId,
            $ai_trace_phase: 'end',
            execution_target: target,
            duration_ms: durationMs,
            result,
            ...(result === 'failure' && { failure_reason: failureReason(snapshot.task) }),
          })
        }
        settleRuntimeRunTraceId(snapshot.address)
      }

      tasksRef.current.set(key, {
        ...current,
        running: nextRunning,
        turnActive: nextTurnActive,
        stopping: nextStopping,
      })
    })
  }, [devices, lifecycle])

  // Close traces for runs this window observed but that never settled, so an
  // app exit mid-task does not leave a permanently open trace.
  useEffect(() => {
    const flushOpenRuns = () => {
      for (const snapshot of lifecycleRef.current.tasks.values()) {
        const traceId = activeRuntimeRunTraceId(snapshot.address)
        if (!traceId) continue
        track('$ai_trace', {
          $ai_trace_id: traceId,
          $ai_trace_phase: 'end',
          execution_target: executionTarget(snapshot.address.deviceId, devicesRef.current),
          result: 'cancelled',
        })
        settleRuntimeRunTraceId(snapshot.address)
        takeGenerationOutcome(snapshot.address)
      }
    }
    window.addEventListener('beforeunload', flushOpenRuns)
    return () => window.removeEventListener('beforeunload', flushOpenRuns)
  }, [])
}
