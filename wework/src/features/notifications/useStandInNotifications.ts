import { createStandInRecordStore, STAND_IN_RECORD_LIMIT } from './standInNotificationStorage'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { isMainWindowFocused } from '@/desktop/windowFocus'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { useTranslation } from '@/hooks/useTranslation'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import type { WeworkInbox } from '@/api/notifications'
import type { TaskSource } from './NotificationTaskSourceContext'
import {
  mergeStandInNotifications,
  matchesStandInVersion,
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
  const observedTasks = useRef({ storageKey: '', startedAt: 0, keys: new Set<string>() })
  useEffect(() => {
    if (observedTasks.current.storageKey !== storageKey) {
      observedTasks.current = { storageKey, startedAt: Date.now(), keys: new Set<string>() }
    }
  }, [storageKey])
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
      if (!item.runtimeItem || !item.payload.standIn) continue
      const state = item.payload.standIn
      const existing = next[item.runtimeItem.key]
      const version = standInVersion(state)
      if (
        existing &&
        (existing.version === version || !matchesStandInVersion(existing.version, state))
      )
        continue
      const liveSettlement =
        !existing &&
        state.status !== 'running' &&
        Date.parse(state.updatedAt) > observedTasks.current.startedAt
      const unread =
        source?.unreadTaskKeys.has(item.runtimeItem.key) ||
        state.status === 'waiting' ||
        liveSettlement
      next[item.runtimeItem.key] = {
        version: !existing && unread ? '' : version,
        savedAt: Date.now(),
      }
      changed = true
    }
    if (changed) store.write(next)
  }, [trackedItems, source?.unreadTaskKeys, store, observedTasks])

  const isUnread = (item: StandInNotification) => {
    if (!item.read_at) return true
    const state = item.payload.standIn
    if (!state || !item.runtimeItem || state.status === 'running') return false
    const readVersion = versions[item.runtimeItem.key]?.version
    return readVersion == null
      ? Boolean(source?.unreadTaskKeys.has(item.runtimeItem.key) || state.status === 'waiting')
      : !matchesStandInVersion(readVersion, state)
  }
  useEffect(() => {
    if (getDesktopWindowLabel() !== 'main') return
    const observedTaskKeys = observedTasks.current.keys
    const currentKeys = new Set(trackedItems.map(item => item.runtimeItem?.key))
    for (const key of observedTaskKeys) {
      if (!currentKeys.has(key)) observedTaskKeys.delete(key)
    }
    const nextDelivered = { ...delivered.getSnapshot() }
    let deliveryChanged = false
    const alerts: Parameters<typeof sendSystemNotification>[0][] = []
    for (const item of trackedItems) {
      const state = item.payload.standIn
      if (!state || !item.runtimeItem) continue
      const firstObservation = !observedTaskKeys.has(item.runtimeItem.key)
      observedTaskKeys.add(item.runtimeItem.key)
      if (state.status === 'running') continue
      const historical =
        firstObservation && Date.parse(state.updatedAt) <= observedTasks.current.startedAt
      const version = standInVersion(state)
      const deliveredVersion = nextDelivered[item.runtimeItem.key]?.version
      const readVersion = store.getSnapshot()[item.runtimeItem.key]?.version
      if (import.meta.env.VITE_WEWORK_E2E === 'true') {
        logRuntimeTaskCreateStage('stand-in-alert', {
          taskKey: item.runtimeItem.key,
          version,
          deliveredVersion,
          readVersion,
          runtimeUnread: source?.unreadTaskKeys.has(item.runtimeItem.key),
          firstObservation,
          historical,
          systemEnabled,
          currentTaskId: source?.currentAddress?.taskId,
        })
      }
      if (deliveredVersion === version) continue
      const alreadyDelivered = matchesStandInVersion(deliveredVersion, state)
      const unread =
        readVersion == null
          ? source?.unreadTaskKeys.has(item.runtimeItem.key) ||
            state.status === 'waiting' ||
            (firstObservation && !historical)
          : !matchesStandInVersion(readVersion, state)
      if (!unread && !firstObservation && !alreadyDelivered) continue
      nextDelivered[item.runtimeItem.key] = { version, savedAt: Date.now() }
      deliveryChanged = true
      // Baseline older settlements, but retain live completions that beat task discovery.
      if (historical || alreadyDelivered || !unread) continue
      const viewingTask =
        source?.currentAddress?.deviceId === state.deviceId &&
        source?.currentAddress?.taskId === state.taskId &&
        isMainWindowFocused()
      // Pending interactions have one shared foreground/background delivery owner.
      if (!systemEnabled || viewingTask || state.status === 'waiting') continue
      alerts.push({
        title: item.payload.taskTitle || item.title,
        body: t(`notifications.stand_in_${state.status}`),
        address: item.runtimeItem.address,
        url: item.url ?? undefined,
      })
    }
    if (deliveryChanged) delivered.write(nextDelivered)
    for (const alert of alerts) void sendSystemNotification(alert)
  }, [
    trackedItems,
    versions,
    source?.unreadTaskKeys,
    source?.currentAddress,
    delivered,
    store,
    storageKey,
    observedTasks,
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
