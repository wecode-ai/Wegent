import type { RuntimeTaskSummary } from '@/types/api'

export function normalizeRuntimeTaskSummary(task: RuntimeTaskSummary): RuntimeTaskSummary {
  if (!isRuntimeTaskAuthoritativeCompletion(task)) return task

  const status = task.status?.trim().toLowerCase()
  const turnStatus = task.turnStatus?.trim().toLowerCase()
  const settledStatus =
    status === 'failed' || status === 'error' || turnStatus === 'failed'
      ? 'failed'
      : status === 'cancelled' || status === 'canceled' || turnStatus === 'interrupted'
        ? 'cancelled'
        : status === 'archived'
          ? 'archived'
          : 'done'
  const settledTurnStatus =
    turnStatus === 'failed' || turnStatus === 'interrupted' ? task.turnStatus : 'completed'

  if (
    task.status === settledStatus &&
    task.turnStatus === settledTurnStatus &&
    task.optimistic !== true
  ) {
    return task
  }

  const canonicalTask = { ...task }
  delete canonicalTask.optimistic
  return {
    ...canonicalTask,
    status: settledStatus,
    turnStatus: settledTurnStatus,
  }
}

export function shouldReplaceRuntimeTaskProjection(
  currentTask: RuntimeTaskSummary,
  candidateTask: RuntimeTaskSummary
): boolean {
  const current = normalizeRuntimeTaskSummary(currentTask)
  const candidate = normalizeRuntimeTaskSummary(candidateTask)
  const currentCompleted = isRuntimeTaskAuthoritativeCompletion(current)
  const candidateCompleted = isRuntimeTaskAuthoritativeCompletion(candidate)

  if (currentCompleted !== candidateCompleted) {
    if (candidateCompleted) return true
    return isRuntimeTaskConfirmedActive(candidate)
  }

  if (current.optimistic === true && candidate.optimistic !== true) {
    return !(
      isRuntimeTaskOptimisticallyActive(current) &&
      candidate.running === false &&
      !isRuntimeTaskQueued(candidate)
    )
  }
  if (current.optimistic !== true && candidate.optimistic === true) return false

  const currentTime = runtimeTaskProjectionTime(current)
  const candidateTime = runtimeTaskProjectionTime(candidate)
  if (candidateTime !== currentTime) return candidateTime > currentTime

  return true
}

export function isRuntimeTaskAuthoritativeCompletion(task: RuntimeTaskSummary): boolean {
  return task.running === false && task.completedAt != null
}

export function isRuntimeTaskConfirmedActive(task: RuntimeTaskSummary): boolean {
  return (
    task.optimistic !== true &&
    task.running === true &&
    task.completedAt == null &&
    (isRuntimeTaskRunningStatus(task.threadStatus) || isRuntimeTaskRunningStatus(task.turnStatus))
  )
}

function isRuntimeTaskOptimisticallyActive(task: RuntimeTaskSummary): boolean {
  return (
    task.optimistic === true &&
    (task.status === 'creating' ||
      task.status === 'queued' ||
      task.status === 'active' ||
      task.status === 'running')
  )
}

function isRuntimeTaskQueued(task: RuntimeTaskSummary): boolean {
  return task.status?.trim().toLowerCase() === 'queued'
}

function isRuntimeTaskRunningStatus(status: string | null | undefined): boolean {
  const normalized = status?.replace(/[_-]/g, '').trim().toLowerCase()
  return normalized === 'active' || normalized === 'inprogress' || normalized === 'running'
}

function runtimeTaskProjectionTime(task: RuntimeTaskSummary): number {
  return Math.max(
    runtimeTaskTimestamp(task.updatedAt),
    runtimeTaskTimestamp(task.completedAt),
    runtimeTaskTimestamp(task.createdAt)
  )
}

function runtimeTaskTimestamp(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}
