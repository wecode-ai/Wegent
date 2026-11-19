import { STAND_IN_RECORD_LIMIT } from './standInNotificationStorage'
import { createStandInNotificationSource } from './standInNotificationSource'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { WeworkInbox } from '@/api/notifications'
import type { TaskSource } from './NotificationTaskSourceContext'
import { useStandInAssignmentTasks } from './useStandInAssignmentTasks'
import {
  mergeStandInNotifications,
  matchesStandInVersion,
  type StandInNotification,
} from './standInNotifications'

/** Read markers belong to this device; execution truth stays in the runtime. */
export function useStandInNotifications(
  inbox: WeworkInbox | null,
  source: TaskSource | null,
  accountKey: string,
  enabled: boolean,
  systemEnabled = false,
  userId: number | null = null
) {
  const { t } = useTranslation('common')
  const storageKey = `wework.stand-in-notifications:${accountKey}`
  const notificationSource = useMemo(
    () => createStandInNotificationSource(storageKey, accountKey),
    [storageKey, accountKey]
  )
  const assignments = useStandInAssignmentTasks(inbox, source, accountKey, enabled)
  const items = useMemo(() => {
    const live = enabled ? (source?.items ?? []) : []
    const visible = new Set(live.map(item => item.key))
    return mergeStandInNotifications(inbox?.items ?? [], [
      ...live,
      ...assignments.items.filter(item => !visible.has(item.key)),
    ]).map(item => ({
      ...item,
      payload: {
        ...item.payload,
        standInLookupPending: !item.payload.standIn && assignments.pending,
        standInLookupError: !item.payload.standIn ? assignments.error : undefined,
      },
    }))
  }, [inbox, source?.items, enabled, assignments.items, assignments.pending, assignments.error])
  const trackedItems = useMemo(
    () =>
      items
        .filter(item => item.payload.standIn)
        .sort(
          (a, b) =>
            Date.parse(b.payload.standIn!.updatedAt) - Date.parse(a.payload.standIn!.updatedAt)
        )
        .slice(0, STAND_IN_RECORD_LIMIT),
    [items]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      notificationSource.subscribe(
        {
          inbox,
          userId,
          trackedItems,
          source,
          systemEnabled,
          message: status => t(`notifications.stand_in_${status}`),
        },
        listener
      ),
    [notificationSource, inbox, userId, trackedItems, source, systemEnabled, t]
  )
  const versions = useSyncExternalStore(
    subscribe,
    notificationSource.getSnapshot,
    notificationSource.getSnapshot
  )

  const isUnread = (item: StandInNotification) => {
    if (!item.read_at) return true
    const state = item.payload.standIn
    if (!state || !item.runtimeItem || state.status === 'running') return false
    const readVersion = versions[item.runtimeItem.key]?.version
    return readVersion == null
      ? Boolean(source?.unreadTaskKeys.has(item.runtimeItem.key) || state.status === 'waiting')
      : !matchesStandInVersion(readVersion, state)
  }
  const timestamp = (item: StandInNotification) => {
    const state = item.payload.standIn
    const runtimeTime = state && state.status !== 'running' ? Date.parse(state.updatedAt) : 0
    return Math.max(
      runtimeTime,
      Date.parse(
        /(?:Z|[+-]\d{2}:\d{2})$/i.test(item.created_at) ? item.created_at : `${item.created_at}Z`
      )
    )
  }
  const unreadLoaded = items.filter(isUnread).length
  const originalUnreadLoaded = inbox?.items.filter(item => !item.read_at).length ?? 0
  return {
    items: [...items].sort((a, b) => timestamp(b) - timestamp(a)),
    unreadCount: Math.max(0, (inbox?.unread_count ?? 0) - originalUnreadLoaded + unreadLoaded),
    isUnread,
    markRead: notificationSource.markRead,
    timestamp,
  }
}
