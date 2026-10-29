import type { WeworkNotification } from '@/api/notifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import {
  normalizeRuntimeTaskSummary,
  runtimeTaskTrackingExecutionStatus,
  runtimeTaskSummaryTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { weworkIssueScheme } from './scheme'

export interface StandInNotificationState {
  deviceId: string
  taskId: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  summary: string
  updatedAt: string
  turnId?: string
}

export type StandInNotification = Omit<WeworkNotification, 'payload'> & {
  payload: WeworkNotification['payload'] & { standIn?: StandInNotificationState }
  runtimeItem?: RuntimeTaskReminderItem
  synthetic?: boolean
}

function runtimeTimestamp(value: string | number | null | undefined): number {
  const parsed = value == null ? 0 : new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

export function standInOrigin(item: RuntimeTaskReminderItem) {
  const origin = item.task.runtimeHandle?.origin
  if (
    !origin ||
    typeof origin !== 'object' ||
    !('initiatedBy' in origin) ||
    origin.initiatedBy !== 'stand_in'
  )
    return null
  const record = origin as Record<string, unknown>
  if (
    typeof record.cloudProjectId !== 'string' ||
    !record.cloudProjectId.trim() ||
    typeof record.loopItemId !== 'string' ||
    !record.loopItemId.trim()
  )
    return null
  return record as Record<string, unknown> & { cloudProjectId: string; loopItemId: string }
}

export function standInState(
  item: Pick<RuntimeTaskReminderItem, 'task' | 'address' | 'lifecycle'>
): StandInNotificationState {
  const task = normalizeRuntimeTaskSummary(item.task)
  const lifecycle = item.lifecycle
  const executionStatus =
    (lifecycle && runtimeTaskTrackingExecutionStatus(lifecycle)) ??
    runtimeTaskSummaryTrackingExecutionStatus(task)
  const interactionStatus = lifecycle ? lifecycle.interactionStatus : task.interactionStatus
  const status = interactionStatus
    ? 'waiting'
    : executionStatus === 'cancelled'
      ? 'cancelled'
      : executionStatus === 'failed'
        ? 'failed'
        : executionStatus === 'succeeded' || executionStatus === 'archived'
          ? 'completed'
          : 'running'
  const timestamp = status === 'waiting' ? task.updatedAt : (task.completedAt ?? task.updatedAt)
  const taskTurnId = task.runtimeHandle?.lastTurnId
  return {
    ...item.address,
    turnId:
      item.lifecycle?.turn.latestId ?? (typeof taskTurnId === 'string' ? taskTurnId : undefined),
    status,
    summary: task.error ?? '',
    updatedAt: new Date(runtimeTimestamp(timestamp)).toISOString(),
  }
}

export function standInVersion(state: StandInNotificationState): string {
  if (state.turnId) {
    return `${state.status}:turn:${state.turnId}${state.status === 'waiting' ? `:${state.updatedAt}` : ''}`
  }
  return `${state.status}:${state.updatedAt}`
}

export function matchesStandInVersion(
  version: string | undefined,
  state: StandInNotificationState
): boolean {
  // Accept existing timestamp markers while migrating to turn identity.
  return version === standInVersion(state) || version === `${state.status}:${state.updatedAt}`
}

export function mergeStandInNotifications(
  notifications: WeworkNotification[],
  items: RuntimeTaskReminderItem[]
): StandInNotification[] {
  const result: StandInNotification[] = notifications.map(notification => ({ ...notification }))
  for (const item of items) {
    const origin = standInOrigin(item)
    if (!origin) continue
    const index = result.findIndex(
      notification =>
        notification.kind === 'issue_dispatch_assignment' &&
        notification.payload.projectId === origin.cloudProjectId &&
        notification.payload.itemId === origin.loopItemId &&
        notification.payload.humanAssignmentId === origin.humanAssignmentId &&
        (!notification.runtimeItem || notification.runtimeItem.key === item.key)
    )
    const state = standInState(item)
    const url = weworkIssueScheme(
      origin.cloudProjectId,
      origin.loopItemId,
      origin.projectStore === 'local' ? 'local' : 'backend'
    )
    const notification: StandInNotification =
      index >= 0
        ? result[index]
        : {
            id: `stand-in:${encodeURIComponent(item.key)}`,
            kind: 'issue_dispatch_assignment',
            title: item.task.title,
            body: '',
            url,
            created_at: new Date(runtimeTimestamp(item.task.createdAt)).toISOString(),
            read_at: 'read',
            payload: {
              projectId: origin.cloudProjectId,
              itemId: origin.loopItemId,
              humanAssignmentId: String(origin.humanAssignmentId),
              taskTitle: item.task.title,
              projectName: item.projectName,
            },
            synthetic: true,
          }
    const merged = {
      ...notification,
      runtimeItem: item,
      url,
      payload: {
        ...notification.payload,
        projectName: notification.payload.projectName || item.projectName,
        standIn: state,
      },
    }
    if (index >= 0) result[index] = merged
    else result.push(merged)
  }
  return result
}
