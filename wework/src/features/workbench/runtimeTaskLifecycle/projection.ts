import type { RuntimeTaskSummary, RuntimeTranscriptResponse } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import type { RuntimeTaskLifecycleSnapshot } from './types'
import {
  runtimeMessagesToWorkbenchMessages,
  runtimeTranscriptTurnsToConversationTurns,
} from '../runtimePaneMessages'

export type RuntimeTaskBoardState = 'attention' | 'queued' | 'active' | 'completed'

export function projectRuntimePaneTranscript(
  transcript: RuntimeTranscriptResponse
): RuntimePaneTranscript {
  return {
    running: transcript.running,
    messages: runtimeMessagesToWorkbenchMessages(transcript.messages ?? []),
    turns: runtimeTranscriptTurnsToConversationTurns(transcript.turns ?? []),
    contextUsage: transcript.contextUsage ?? null,
    turnNavigation: transcript.turnNavigation ?? [],
    fullContent: transcript.fullContent === true,
    rangeStart: transcript.rangeStart ?? null,
    rangeEnd: transcript.rangeEnd ?? null,
    hasMoreBefore: Boolean(transcript.hasMoreBefore),
    beforeCursor: transcript.beforeCursor ?? null,
    hasMoreAfter: Boolean(transcript.hasMoreAfter),
    afterCursor: transcript.afterCursor ?? null,
  }
}

export function isRuntimePaneTranscriptConfirmedIdle(transcript: RuntimePaneTranscript): boolean {
  if (transcript.running !== false) return false
  return !transcript.turns.some(turn => isRuntimeTurnRunningStatus(turn.status))
}

export function runtimeTaskBoardState(task: RuntimeTaskSummary): RuntimeTaskBoardState {
  const normalizedTask = normalizeRuntimeTaskSummary(task)
  const status = normalizedTask.status?.trim().toLowerCase()
  const turnStatus = normalizedTask.turnStatus?.trim().toLowerCase()
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'canceled' ||
    turnStatus === 'failed' ||
    turnStatus === 'interrupted'
  ) {
    return 'attention'
  }
  if (
    normalizedTask.running === true ||
    isRuntimeTaskConfirmedActive(normalizedTask) ||
    isRuntimeTaskOptimisticallyActive(normalizedTask)
  ) {
    return 'active'
  }
  if (isRuntimeTaskQueued(normalizedTask)) return 'queued'
  if (isRuntimeTaskAuthoritativeCompletion(normalizedTask)) return 'completed'
  return 'attention'
}

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

export function runtimeTaskReconciliationSnapshot(task: RuntimeTaskSummary): {
  runtimeStatus: string
  running: boolean
  turnStatus: string | null
} {
  const canonical = normalizeRuntimeTaskSummary(task)
  return {
    runtimeStatus: canonical.status ?? '',
    running: isRuntimeTaskConfirmedActive(canonical),
    turnStatus: canonical.turnStatus ?? null,
  }
}

export function shouldReplaceRuntimeTaskProjection(
  currentTask: RuntimeTaskSummary,
  candidateTask: RuntimeTaskSummary
): boolean {
  const current = normalizeRuntimeTaskSummary(currentTask)
  const candidate = normalizeRuntimeTaskSummary(candidateTask)
  if (current.cachedProjection !== candidate.cachedProjection) {
    return current.cachedProjection === true
  }
  const currentCompleted = isRuntimeTaskAuthoritativeCompletion(current)
  const candidateCompleted = isRuntimeTaskAuthoritativeCompletion(candidate)

  if (currentCompleted !== candidateCompleted) {
    if (candidateCompleted) return true
    if (!isRuntimeTaskConfirmedActive(candidate)) return false
    const candidateTime = runtimeTaskProjectionTime(candidate)
    return candidateTime === 0 || candidateTime > runtimeTaskTimestamp(current.completedAt)
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

export type RuntimeTaskTrackingExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'archived'

export function runtimeTaskTrackingExecutionStatus(
  lifecycle: RuntimeTaskLifecycleSnapshot
): RuntimeTaskTrackingExecutionStatus | null {
  if (lifecycle.derived.isQueued) return 'queued'
  if (lifecycle.turn.active) return 'running'
  if (lifecycle.turn.outcome) return lifecycle.turn.outcome
  if (lifecycle.derived.isRunning) return 'running'

  const task = lifecycle.task
  if (!task) return null
  const status = task.status?.trim().toLowerCase()
  const turnStatus = task.turnStatus?.trim().toLowerCase()
  if (status === 'archived') return 'archived'
  if (status === 'failed' || status === 'error' || turnStatus === 'failed') return 'failed'
  if (
    status === 'cancelled' ||
    status === 'canceled' ||
    turnStatus === 'cancelled' ||
    turnStatus === 'canceled' ||
    turnStatus === 'interrupted'
  ) {
    return 'cancelled'
  }
  if (status === 'queued') return 'queued'
  if (task.running === true) return 'running'
  if (isRuntimeTaskAuthoritativeCompletion(task)) return 'succeeded'
  return null
}

export function isRuntimeTaskConfirmedActive(task: RuntimeTaskSummary): boolean {
  return (
    task.optimistic !== true &&
    task.running === true &&
    task.completedAt == null &&
    (isRuntimeTaskRunningStatus(task.threadStatus) || isRuntimeTaskRunningStatus(task.turnStatus))
  )
}

export function isRuntimeTaskExecutionRunning(task: RuntimeTaskSummary): boolean {
  const normalizedTask = normalizeRuntimeTaskSummary(task)
  return (
    normalizedTask.optimistic !== true &&
    normalizedTask.running === true &&
    normalizedTask.completedAt == null
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

function isRuntimeTurnRunningStatus(status: string | null | undefined): boolean {
  const normalized = status?.replace(/[_-]/g, '').trim().toLowerCase()
  return (
    normalized === 'active' ||
    normalized === 'inprogress' ||
    normalized === 'pending' ||
    normalized === 'streaming'
  )
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
