import { executionDisplayStatus } from '@wegent/collaboration'
import { standInWorkRole } from '@/features/todo/standInWork'
import {
  runtimeTaskSummaryTrackingExecutionStatus,
  runtimeTaskTrackingExecutionStatus,
  shouldReplaceRuntimeTaskProjection,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type {
  ExperienceTaskRow,
  ExperienceWorkCounts,
  ExperienceWorkSnapshot,
  ExperienceWorkSnapshotInput,
  ExperienceWorkSnapshotItem,
  ExperienceWorkState,
} from './types'

const emptyCounts = (): ExperienceWorkCounts => ({ waiting: 0, running: 0, completed: 0 })

function roleIdentity(id: string | null): string | null {
  return id === '@primary' ? null : id
}

function workState(item: RuntimeTaskReminderItem): ExperienceWorkState {
  const task = item.lifecycle?.task ?? item.task
  const origin = task.runtimeHandle?.origin as Record<string, unknown> | undefined
  if (task.status === 'archived') return 'completed'
  if (item.lifecycle ? item.lifecycle.interactionStatus : task.interactionStatus) return 'waiting'
  if (origin?.inboxStatus === 'pending' || origin?.inboxStatus === 'needs_grouping')
    return 'waiting'
  if (origin?.inboxStatus === 'sending') return 'running'
  if (origin?.inboxStatus === 'sent') return 'completed'
  if (origin?.inboxStatus === 'failed') return 'idle'
  if (task.executionState?.phase === 'idle')
    return task.executionState.outcome === 'succeeded' ? 'completed' : 'idle'
  const status = item.lifecycle
    ? runtimeTaskTrackingExecutionStatus(item.lifecycle)
    : runtimeTaskSummaryTrackingExecutionStatus(task)
  if (status === 'running' || status === 'queued') return 'running'
  return status === 'succeeded' || status === 'archived' ? 'completed' : 'idle'
}

function timestamp(value: string | number | null | undefined): number {
  const time = value == null ? 0 : new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function workItems(input: ExperienceWorkSnapshotInput): ExperienceWorkSnapshotItem[] {
  const unique = new Map<string, RuntimeTaskReminderItem>()
  for (const item of input.work) {
    if (standInWorkRole(item) === null) continue
    const key = JSON.stringify([item.address.deviceId, item.address.taskId])
    const previous = unique.get(key)
    if (!previous || shouldReplaceRuntimeTaskProjection(previous.task, item.task))
      unique.set(key, item)
  }
  const items: ExperienceWorkSnapshotItem[] = [...unique].map(([key, item]) => ({
    key,
    title: item.task.title,
    state: workState(item),
    roleIds: [roleIdentity(standInWorkRole(item))],
    updatedAt: new Date(timestamp(item.task.updatedAt ?? item.task.completedAt)).toISOString(),
    address: { ...item.address },
  }))
  const decisions = new Map((input.pendingDecisions ?? []).map(item => [item.id, item]))
  for (const decision of decisions.values())
    items.push({
      key: JSON.stringify(['proposal', decision.id]),
      title: decision.summary,
      state: 'waiting',
      roleIds: [roleIdentity(decision.roleId)],
      updatedAt: '',
    })
  return items
}

export function selectExperienceTaskState(row: ExperienceTaskRow): ExperienceWorkState {
  if (row.completedAt || ['completed', 'cancelled', 'archived'].includes(row.status))
    return 'completed'
  if (row.needsUser) return 'waiting'
  const execution = executionDisplayStatus(row.executionState)
  if (
    execution &&
    ['queued', 'starting', 'waiting_runtime', 'running', 'cancelling'].includes(execution)
  )
    return 'running'
  return !execution && row.status === 'in_progress' ? 'running' : 'idle'
}

function taskItems(rows: readonly ExperienceTaskRow[]): ExperienceWorkSnapshotItem[] {
  const unique = new Map<string, ExperienceTaskRow>()
  for (const row of rows) {
    const previous = unique.get(row.key)
    if (!previous || timestamp(row.updatedAt) > timestamp(previous.updatedAt))
      unique.set(row.key, row)
  }
  return [...unique.values()].map(row => ({
    key: row.key,
    title: row.title,
    state: selectExperienceTaskState(row),
    roleIds: [],
    updatedAt: row.updatedAt,
    taskRow: row,
  }))
}

function countItems(items: readonly ExperienceWorkSnapshotItem[]): ExperienceWorkCounts {
  const counts = emptyCounts()
  for (const item of items) if (item.state !== 'idle') counts[item.state] += 1
  return counts
}

/** Both surfaces share work semantics; only the explicitly visible list sets its own counts. */
export function selectExperienceWorkSnapshot(
  input: ExperienceWorkSnapshotInput
): ExperienceWorkSnapshot {
  const work = workItems(input)
  const items = input.rows === undefined ? work : taskItems(input.rows)
  const current = items
    .filter(item => item.state === 'running')
    .sort(
      (a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.key.localeCompare(b.key)
    )[0]
  const roles = new Map(
    input.roles.map(role => [role.isDefault ? null : roleIdentity(role.id), role])
  )
  return {
    items,
    counts: countItems(items),
    current: current ?? null,
    team: [...roles].map(([id, role]) => {
      const counts = countItems(work.filter(item => item.roleIds.includes(id)))
      return {
        ...role,
        id,
        counts,
        state: counts.waiting ? 'waiting' : counts.running ? 'running' : 'idle',
      }
    }),
  }
}
