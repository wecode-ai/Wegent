import { useEffect, useRef } from 'react'
import type { DeviceInfo, ProjectWithTasks, RuntimeTaskSummary } from '@/types/api'
import type { RuntimeTaskLifecycleStoreSnapshot } from './runtimeTaskLifecycle'
import type { ExecutionTarget, TelemetryFailureReason, TelemetryResult } from '@/telemetry/events'
import { track } from '@/telemetry/client'

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
}

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

  useEffect(() => {
    if (!currentProject || projectIdRef.current === currentProject.id) return
    projectIdRef.current = currentProject.id
    track('project_opened', { source: projectSource(currentProject) })
  }, [currentProject])

  useEffect(() => {
    lifecycle.tasks.forEach((snapshot, key) => {
      const previous = tasksRef.current.get(key)
      const target = executionTarget(snapshot.address.deviceId, devices)
      const current: ObservedTask = previous ?? {
        firstResponseRecorded: false,
        running: false,
        startedAt: null,
        turnActive: false,
      }

      if (!current.running && snapshot.derived.isRunning) {
        const now = Date.now()
        current.startedAt = now
        track('task_started', { execution_target: target })
        track('$ai_trace', {
          $ai_trace_id: snapshot.address.taskId,
          $ai_trace_phase: 'start',
          execution_target: target,
        })
      }
      if (current.turnActive && !snapshot.derived.isTurnActive && !current.firstResponseRecorded) {
        current.firstResponseRecorded = true
        track('first_response_completed', {
          duration_ms: Math.max(0, Date.now() - (current.startedAt ?? Date.now())),
          execution_target: target,
          result: taskResult(snapshot.task),
        })
      }
      if (current.running && !snapshot.derived.isRunning) {
        const now = Date.now()
        const result = taskResult(snapshot.task)
        const durationMs = current.startedAt != null ? Math.max(0, now - current.startedAt) : 0
        track('task_completed', {
          duration_ms: durationMs,
          execution_target: target,
          result,
          ...(result === 'failure' && { failure_reason: failureReason(snapshot.task) }),
        })
        track('$ai_trace', {
          $ai_trace_id: snapshot.address.taskId,
          $ai_trace_phase: 'end',
          execution_target: target,
          duration_ms: durationMs,
          result,
          ...(result === 'failure' && { failure_reason: failureReason(snapshot.task) }),
        })
      }

      tasksRef.current.set(key, {
        ...current,
        running: snapshot.derived.isRunning,
        turnActive: snapshot.derived.isTurnActive,
      })
    })
  }, [devices, lifecycle])
}
