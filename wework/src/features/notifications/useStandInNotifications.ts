import { createStandInRecordStore, STAND_IN_RECORD_LIMIT } from './standInNotificationStorage'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { isMainWindowFocused } from '@/desktop/windowFocus'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { useTranslation } from '@/hooks/useTranslation'
import type { WeworkInbox } from '@/api/notifications'
import type { TaskSource } from './NotificationTaskSourceContext'
import {
  mergeStandInNotifications,
  standInVersion,
  type StandInNotification,
} from './standInNotifications'

/** Read markers belong to this device; execution truth stays in the runtime. */
export function useStandInNotifications(
  inbox: WeworkInbox | null,
  source: TaskSource | null,
  accountKey: string,
  enabled: boolean,
  systemEnabled = false
) {
  const { t } = useTranslation('common')
  const storageKey = `wework.stand-in-notifications:${accountKey}`
  const store = useMemo(() => createStandInRecordStore(storageKey), [storageKey])
  const versions = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const delivered = useMemo(() => createStandInRecordStore(`${storageKey}:delivered`), [storageKey])
  const items = useMemo(
    () => mergeStandInNotifications(inbox?.items ?? [], enabled ? (source?.items ?? []) : []),
    [inbox, source?.items, enabled]
  )
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
  useEffect(() => {
    const current = store.getSnapshot()
    const next = { ...current }
    let changed = false
    for (const item of trackedItems) {
      if (!item.runtimeItem || !item.payload.standIn || item.runtimeItem.key in next) continue
      const unread =
        source?.unreadTaskKeys.has(item.runtimeItem.key) ||
        item.payload.standIn.status === 'waiting'
      next[item.runtimeItem.key] = {
        version: unread ? '' : standInVersion(item.payload.standIn),
        savedAt: Date.now(),
      }
      changed = true
    }
    if (changed) store.write(next)
  }, [trackedItems, source?.unreadTaskKeys, store])

  const isUnread = (item: StandInNotification) => {
    if (!item.read_at) return true
    const state = item.payload.standIn
    if (!state || !item.runtimeItem || state.status === 'running') return false
    const readVersion = versions[item.runtimeItem.key]?.version
    return readVersion == null
      ? Boolean(source?.unreadTaskKeys.has(item.runtimeItem.key) || state.status === 'waiting')
      : readVersion !== standInVersion(state)
  }
  useEffect(() => {
    if (getDesktopWindowLabel() !== 'main') return
    for (const item of trackedItems) {
      const state = item.payload.standIn
      if (!state || !item.runtimeItem || state.status === 'running') continue
      const version = standInVersion(state)
      if (delivered.getSnapshot()[item.runtimeItem.key]?.version === version) continue
      const readVersion = versions[item.runtimeItem.key]?.version
      const unread =
        readVersion == null
          ? source?.unreadTaskKeys.has(item.runtimeItem.key) || state.status === 'waiting'
          : readVersion !== version
      if (!unread) continue
      delivered.write({
        ...delivered.getSnapshot(),
        [item.runtimeItem.key]: { version, savedAt: Date.now() },
      })
      const viewingTask =
        source?.currentAddress?.deviceId === state.deviceId &&
        source?.currentAddress?.taskId === state.taskId &&
        isMainWindowFocused()
      if (!systemEnabled || viewingTask) continue
      void sendSystemNotification({
        title: item.payload.taskTitle || item.title,
        body: t(`notifications.stand_in_${state.status}`),
        address: item.runtimeItem.address,
        url: item.url ?? undefined,
      })
    }
  }, [
    trackedItems,
    versions,
    source?.unreadTaskKeys,
    source?.currentAddress,
    delivered,
    systemEnabled,
    t,
  ])
  const markRead = (readItems: StandInNotification[]) => {
    for (const item of readItems) {
      if (item.runtimeItem) source?.markRuntimeTaskRead(item.runtimeItem.address)
    }
    const current = store.getSnapshot()
    const next = { ...current }
    for (const item of readItems) {
      if (!item.runtimeItem || !item.payload.standIn) continue
      next[item.runtimeItem.key] = {
        version: standInVersion(item.payload.standIn),
        savedAt: Date.now(),
      }
    }
    store.write(next)
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
    markRead,
    timestamp,
  }
}
