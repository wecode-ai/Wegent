import type { WeworkInbox } from '@/api/notifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { syncNotificationUnreadCount } from '@/desktop/trayNavigation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { standInOrigin } from './standInNotifications'
import type { useNotificationTaskSource } from './NotificationTaskSourceContext'

interface Input {
  taskSource: ReturnType<typeof useNotificationTaskSource>
  collaborationUnreadCount: number
  generalInbox: WeworkInbox | null
}
export function taskTimestamp(item: RuntimeTaskReminderItem): number {
  const value = item.task.completedAt ?? item.task.updatedAt ?? item.task.createdAt
  if (value == null) return 0
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}
function summarize(
  { taskSource, collaborationUnreadCount, generalInbox }: Input,
  previous?: ReturnType<typeof buildSummary>
) {
  const unreadTasks = taskSource?.unreadTaskKeys.size
    ? taskSource.items.filter(
        item => taskSource.unreadTaskKeys.has(item.key) && !standInOrigin(item)
      )
    : []
  const cloudUnreadCount = collaborationUnreadCount + (generalInbox?.unread_count ?? 0)
  const taskUnreadCount = unreadTasks.reduce(
    (total, item) => total + (taskSource?.unreadMessageCounts?.get(item.key) ?? 1),
    0
  )
  if (
    previous &&
    previous.cloudUnreadCount === cloudUnreadCount &&
    previous.taskUnreadCount === taskUnreadCount &&
    previous.unreadTasks.length === unreadTasks.length &&
    unreadTasks.every((item, index) => item === previous.unreadTasks[index])
  ) {
    return previous
  }
  return buildSummary(unreadTasks, cloudUnreadCount, taskUnreadCount)
}

function buildSummary(
  unreadTasks: RuntimeTaskReminderItem[],
  cloudUnreadCount: number,
  taskUnreadCount: number
) {
  return {
    unreadTasks,
    sortedTasks: [...unreadTasks].sort((a, b) => taskTimestamp(b) - taskTimestamp(a)),
    cloudUnreadCount,
    taskUnreadCount,
    unreadCount: taskUnreadCount + cloudUnreadCount,
  }
}
let badgeOwner: object | null = null

/** One live notification surface projects task and cloud feeds for the bell, list and native badge. */
export function createNotificationCenterSummary() {
  const owner = {}
  let snapshot = summarize({ taskSource: null, collaborationUnreadCount: 0, generalInbox: null })
  const listeners = new Set<() => void>()
  let observation = 0
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, input: Input) {
      const revision = ++observation
      const previous = snapshot
      snapshot = summarize(input, previous)
      listeners.add(listener)
      if (
        getDesktopWindowLabel() === 'main' &&
        (badgeOwner !== owner || previous.unreadCount !== snapshot.unreadCount)
      ) {
        badgeOwner = owner
        syncNotificationUnreadCount(snapshot.unreadCount)
      }
      if (snapshot !== previous) for (const observer of listeners) observer()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || revision !== observation || badgeOwner !== owner) return
          badgeOwner = null
          syncNotificationUnreadCount(0)
        })
      }
    },
  }
}
