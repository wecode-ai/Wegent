import type { WeworkNotificationPreferences } from '@/api/notifications'
import { defaultAppPreferences, type AppPreferences } from '@/desktop/appPreferences'
import type { RuntimeTaskAddress } from '@/types/api'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { standInOrigin } from '@/features/notifications/standInNotifications'
import { suppressesRuntimeTaskCompletionReminder } from '@/lib/runtime-task-visibility'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import type { RuntimeTaskReminderItem, RuntimeTaskReminderState } from './runtimeTaskReminders'
import { isStandInIdentity } from './useStandInMessageReminders'
import {
  getRuntimeTaskNotificationText,
  runtimeTaskNotificationCategory,
} from './runtimeTaskNotificationContent'
import { sendSystemNotification } from './runtimeTaskSystemNotifications'

interface Input {
  items: RuntimeTaskReminderItem[]
  listedItems: RuntimeTaskReminderItem[]
  notificationPreferences: WeworkNotificationPreferences
  unreadMessageCounts: ReadonlyMap<string, number>
  preferences: AppPreferences
  publish?: (reminders: RuntimeTaskReminderState) => void
}

export const EMPTY_RUNTIME_TASK_REMINDERS: RuntimeTaskReminderState = {
  unreadTaskKeys: new Set<string>(),
  unreadCount: 0,
  hasRunningTasks: false,
  preferences: defaultAppPreferences,
  markRuntimeTaskRead: () => {},
  items: [],
}

export function projectRuntimeTaskReminders(
  input: Pick<
    RuntimeTaskReminderState,
    | 'unreadTaskKeys'
    | 'unreadMessageCounts'
    | 'hasRunningTasks'
    | 'preferences'
    | 'items'
    | 'markRuntimeTaskRead'
  >
): RuntimeTaskReminderState {
  return {
    ...input,
    unreadCount: [...input.unreadTaskKeys].reduce(
      (total, key) => total + (input.unreadMessageCounts?.get(key) ?? 1),
      0
    ),
  }
}

function notificationIdentity(item: RuntimeTaskReminderItem): string {
  return `${item.task.taskId}\0${item.address.workspacePath ?? item.workspace.workspacePath ?? ''}`
}

function reportsToStandIn(task: RuntimeTaskReminderItem['task']): boolean {
  const execution = task.runtimeHandle?.executionRequest as
    | { standInReportTo?: { taskId?: unknown } }
    | undefined
  return typeof execution?.standInReportTo?.taskId === 'string'
}

/** Canonical read markers, delivery de-duplication and visible unread keys share one owner. */
export function createRuntimeTaskReminderSource(store: RuntimeTaskLifecycleStore) {
  let input: Input | undefined
  const markRuntimeTaskRead = (address: RuntimeTaskAddress) => store.markRead(address)
  let snapshot = { ...EMPTY_RUNTIME_TASK_REMINDERS, markRuntimeTaskRead }
  let previousUnread: ReadonlySet<string> = new Set()
  const notified = new Set<string>()
  const awaitingMetadata = new Map<string, WeworkNotificationPreferences>()
  const listeners = new Set<() => void>()
  let stopStore: (() => void) | undefined
  let stopFocus: (() => void) | undefined
  let generation = 0
  let observation = 0
  let reconciling = false
  let pending = false
  function suppressesCompletionReminder(item: RuntimeTaskReminderItem): boolean {
    const latestTask = store.getTask(item.address)?.task
    return (
      suppressesRuntimeTaskCompletionReminder(item.task) ||
      (latestTask != null && suppressesRuntimeTaskCompletionReminder(latestTask))
    )
  }
  function hasStandInReport(item: RuntimeTaskReminderItem): boolean {
    const latestTask = store.getTask(item.address)?.task
    return reportsToStandIn(item.task) || (latestTask != null && reportsToStandIn(latestTask))
  }
  function deliver(item: RuntimeTaskReminderItem) {
    const epoch = generation
    if (globalThis.localStorage?.getItem('wework:debug-runtime') === '1')
      console.info('[Wework] Runtime task reminder system-notification-send', {
        key: item.key.replace(/\0/g, '::'),
        taskId: item.task.taskId,
        title: item.task.title,
      })
    void getRuntimeTaskNotificationText(item)
      .then(notification => {
        if (
          epoch !== generation ||
          !listeners.size ||
          suppressesCompletionReminder(item) ||
          hasStandInReport(item) ||
          !input?.notificationPreferences[runtimeTaskNotificationCategory(item)].system
        )
          return
        return sendSystemNotification({ ...notification, address: item.address })
      })
      .catch(error => console.warn('[Wework] Failed to send runtime task notification', error))
  }
  function publishSnapshot(current: Input, unreadTaskKeys: ReadonlySet<string>) {
    const { unreadMessageCounts, items, preferences } = current
    const hasRunningTasks = store.getSidebarSnapshot().runningTaskKeys.size > 0
    if (
      unreadTaskKeys === snapshot.unreadTaskKeys &&
      unreadMessageCounts === snapshot.unreadMessageCounts &&
      items === snapshot.items &&
      preferences === snapshot.preferences &&
      hasRunningTasks === snapshot.hasRunningTasks
    )
      return
    const unreadChanged = unreadTaskKeys !== snapshot.unreadTaskKeys
    snapshot = projectRuntimeTaskReminders({
      unreadTaskKeys,
      unreadMessageCounts,
      hasRunningTasks,
      preferences,
      items,
      markRuntimeTaskRead,
    })
    current.publish?.(snapshot)
    if (unreadChanged) for (const listener of listeners) listener()
  }
  function reconcile() {
    if (!input || !listeners.size) return
    if (reconciling) {
      pending = true
      return
    }
    reconciling = true
    try {
      do {
        pending = false
        const current = input
        const lifecycle = store.getSnapshot()
        const newlyUnread = [...lifecycle.unreadTaskKeys].filter(
          key => !previousUnread.has(key) && store.isNewlyUnread(key)
        )
        previousUnread = new Set(lifecycle.unreadTaskKeys)
        for (const key of awaitingMetadata.keys())
          if (!lifecycle.unreadTaskKeys.has(key)) awaitingMetadata.delete(key)
        const focused = isMainWindowFocused()
        if (focused) awaitingMetadata.clear()
        const candidates = new Set([...newlyUnread, ...awaitingMetadata.keys()])
        const byKey =
          notified.size || candidates.size
            ? new Map(current.items.map(item => [item.key, item]))
            : undefined
        if (notified.size)
          for (const key of lifecycle.runningTaskKeys) {
            const item = byKey?.get(key)
            if (item) notified.delete(notificationIdentity(item))
          }
        if (!focused)
          for (const key of candidates) {
            const item = byKey?.get(key)
            if (!item) {
              if (!awaitingMetadata.has(key))
                awaitingMetadata.set(key, current.notificationPreferences)
              continue
            }
            const originalPreferences = awaitingMetadata.get(key)
            awaitingMetadata.delete(key)
            if (
              (originalPreferences &&
                !originalPreferences[runtimeTaskNotificationCategory(item)].system) ||
              isStandInIdentity(item) ||
              suppressesCompletionReminder(item) ||
              hasStandInReport(item) ||
              standInOrigin(item) ||
              !current.notificationPreferences[runtimeTaskNotificationCategory(item)].system ||
              item.lifecycle?.interactionStatus ||
              item.task.interactionStatus ||
              notified.has(notificationIdentity(item))
            )
              continue
            notified.add(notificationIdentity(item))
            deliver(item)
          }
        if (lifecycle.unreadTaskKeys.size)
          for (const item of current.items) {
            if (
              lifecycle.unreadTaskKeys.has(item.key) &&
              !standInOrigin(item) &&
              !current.notificationPreferences[runtimeTaskNotificationCategory(item)].in_app
            )
              store.markRead(item.address)
          }
        const unreadKeys = store.getSnapshot().unreadTaskKeys
        const visibleUnread = new Set<string>()
        if (unreadKeys.size)
          for (const item of current.listedItems) {
            if (
              unreadKeys.has(item.key) &&
              !isStandInIdentity(item) &&
              !suppressesCompletionReminder(item) &&
              (current.notificationPreferences[runtimeTaskNotificationCategory(item)].in_app ||
                standInOrigin(item))
            ) {
              visibleUnread.add(item.key)
            }
          }
        const next = new Set([
          ...[...unreadKeys].filter(key => visibleUnread.has(key)),
          ...[...current.unreadMessageCounts].filter(([, count]) => count > 0).map(([key]) => key),
        ])
        const previous = snapshot.unreadTaskKeys
        const sameUnreadKeys =
          next.size === previous.size && [...next].every(key => previous.has(key))
        publishSnapshot(current, sameUnreadKeys ? previous : next)
      } while (pending && listeners.size)
    } finally {
      reconciling = false
    }
  }
  return {
    getSnapshot: () => snapshot.unreadTaskKeys,
    markRuntimeTaskRead,
    subscribe(listener: () => void, next: Input) {
      const previousPublisher = input?.publish
      const previousSnapshot = snapshot
      input = next
      const revision = ++observation
      listeners.add(listener)
      if (!stopStore) {
        stopStore = store.subscribe(reconcile)
        stopFocus = subscribeMainWindowFocus(reconcile)
      }
      reconcile()
      if (next.publish !== previousPublisher && snapshot === previousSnapshot)
        next.publish?.(snapshot)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || revision !== observation) return
          generation += 1
          awaitingMetadata.clear()
          stopStore?.()
          stopStore = undefined
          stopFocus?.()
          stopFocus = undefined
        })
      }
    },
  }
}
