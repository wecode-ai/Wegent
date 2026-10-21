import type { WeworkNotification } from '@/api/notifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import {
  normalizeRuntimeTaskSummary,
  runtimeTaskBoardState,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { weworkTaskScheme } from './scheme'

export interface StandInNotificationState {
  deviceId: string
  taskId: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  summary: string
  updatedAt: string
}

export type StandInNotification = Omit<WeworkNotification, 'payload'> & {
  payload: WeworkNotification['payload'] & { standIn?: StandInNotificationState }
  runtimeItem?: RuntimeTaskReminderItem
  synthetic?: boolean
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
  return origin as Record<string, unknown>
}

export function standInState(item: RuntimeTaskReminderItem): StandInNotificationState {
  const task = normalizeRuntimeTaskSummary(item.task)
  const status = task.interactionStatus
    ? 'waiting'
    : task.status === 'cancelled' || task.status === 'canceled' || task.turnStatus === 'interrupted'
      ? 'cancelled'
      : task.status === 'failed' || task.status === 'error' || task.turnStatus === 'failed'
        ? 'failed'
        : runtimeTaskBoardState(task) === 'completed'
          ? 'completed'
          : 'running'
  const timestamp = status === 'waiting' ? task.updatedAt : (task.completedAt ?? task.updatedAt)
  const parsed = timestamp == null ? 0 : new Date(timestamp).getTime()
  return {
    ...item.address,
    status,
    summary: task.error ?? '',
    updatedAt: new Date(Number.isFinite(parsed) ? parsed : 0).toISOString(),
  }
}

export function standInVersion(state: StandInNotificationState): string {
  return `${state.status}:${state.updatedAt}`
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
        notification.payload.humanAssignmentId === origin.humanAssignmentId
    )
    const state = standInState(item)
    const notification: StandInNotification =
      index >= 0
        ? result[index]
        : {
            id: `stand-in:${encodeURIComponent(item.key)}`,
            kind: 'issue_dispatch_assignment',
            title: item.task.title,
            body: '',
            url: weworkTaskScheme(item.address),
            created_at: new Date(item.task.createdAt ?? 0).toISOString(),
            read_at: 'read',
            payload: {
              projectId: String(origin.cloudProjectId),
              itemId: String(origin.loopItemId),
              humanAssignmentId: String(origin.humanAssignmentId),
              taskTitle: item.task.title,
              projectName: item.projectName,
            },
            synthetic: true,
          }
    const merged = {
      ...notification,
      runtimeItem: item,
      url: weworkTaskScheme(item.address),
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
