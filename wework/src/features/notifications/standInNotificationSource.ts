import { createStandInAssignmentDelivery } from './standInAssignmentDelivery'
import type { WeworkInbox } from '@/api/notifications'
import { createStandInRecordStore, type StandInRecords } from './standInNotificationStorage'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { isMainWindowFocused } from '@/desktop/windowFocus'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import type { TaskSource } from './NotificationTaskSourceContext'
import {
  matchesStandInVersion,
  standInVersion,
  type StandInNotification,
  type StandInNotificationState,
} from './standInNotifications'

interface NotificationObservation {
  inbox: WeworkInbox | null
  userId: number | null
  trackedItems: StandInNotification[]
  source: TaskSource | null
  systemEnabled: boolean
  message(status: StandInNotificationState['status']): string
}

/** Device-local read and delivery receipts own notification reconciliation for one account. */
export function createStandInNotificationSource(storageKey: string, accountKey: string) {
  const assignmentDelivery = createStandInAssignmentDelivery(accountKey)
  let snapshot: StandInRecords = {}
  let store: ReturnType<typeof createStandInRecordStore> | undefined
  let delivered: ReturnType<typeof createStandInRecordStore> | undefined
  let startedAt: number | undefined
  const observedKeys = new Set<string>()
  const listeners = new Set<() => void>()
  let observation: NotificationObservation | undefined
  let stop: (() => void) | undefined
  let reconciling = false
  const publish = () => {
    const next = store!.getSnapshot()
    if (next === snapshot) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  const reconcile = () => {
    if (reconciling || !observation || !listeners.size || !store || !delivered) return
    reconciling = true
    const { trackedItems, source, systemEnabled } = observation
    try {
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
          !existing && state.status !== 'running' && Date.parse(state.updatedAt) > startedAt!
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
      if (getDesktopWindowLabel() !== 'main') return
      const observedTaskKeys = observedKeys
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
        const historical = firstObservation && Date.parse(state.updatedAt) <= startedAt!
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
          body: observation.message(state.status),
          address: item.runtimeItem.address,
          url: item.url ?? undefined,
        })
      }
      if (deliveryChanged) delivered.write(nextDelivered)
      for (const alert of alerts) void sendSystemNotification(alert)
    } finally {
      reconciling = false
      publish()
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(input: NotificationObservation, listener: () => void) {
      observation = input
      listeners.add(listener)
      assignmentDelivery.observe({ inbox: input.inbox, source: input.source, userId: input.userId })
      if (!store) {
        startedAt = Date.now()
        store = createStandInRecordStore(storageKey)
        delivered = createStandInRecordStore(`${storageKey}:delivered`)
      }
      if (!stop) {
        const update = () => {
          reconcile()
          publish()
        }
        const releaseRead = store.subscribe(update)
        const releaseDelivered = delivered!.subscribe(update)
        stop = () => {
          releaseRead()
          releaseDelivered()
        }
      }
      reconcile()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          assignmentDelivery.suspend()
          queueMicrotask(() => {
            if (!listeners.size) assignmentDelivery.release()
          })
          stop?.()
          stop = undefined
          observation = undefined
        }
      }
    },
    markRead(readItems: StandInNotification[]) {
      if (!observation || !listeners.size || !store) return
      const source = observation.source
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
    },
  }
}
