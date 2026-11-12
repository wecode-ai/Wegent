import { useEffect, useRef, useState } from 'react'
import type { WeworkInbox } from '@/api/notifications'
import { subscribePersonalStandIn } from '@/api/personalStandIn'
import { subscribeStandInSettings } from '@/api/standIn'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { workbenchDeviceMatchesId } from '@/lib/workbench-device'
import type { TaskSource } from './NotificationTaskSourceContext'

/** Reuse the loaded inbox, including missed notifications received after reconnect. */
export function useStandInAssignmentNotifications(
  inbox: WeworkInbox | null,
  source: TaskSource | null,
  accountKey: string,
  userId: number | null
) {
  const attempted = useRef(new Set<string>())
  const failures = useRef(new Map<string, { count: number; retryAt: number }>())
  const [retryAt, setRetryAt] = useState<number | null>(null)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const api = source?.services?.standInApi
  const identity = source?.services?.getLocalRuntimeSidebarIdentity
  const devices = source?.devices
  const wakeAt = (at: number) =>
    setRetryAt(current => (current == null ? at : Math.min(current, at)))
  useEffect(() => {
    if (retryAt == null) return
    const timer = setTimeout(
      () => {
        setRetryAt(null)
        setSettingsRevision(revision => revision + 1)
      },
      Math.max(0, retryAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [retryAt])
  useEffect(() => {
    const retryUpdatedDevice = (settings: { userId: number; executionDeviceId: string }) => {
      if (settings.userId !== userId) return
      const prefix = `${accountKey}:${userId}:${settings.executionDeviceId}:`
      for (const key of attempted.current) {
        if (key.startsWith(prefix)) attempted.current.delete(key)
      }
      for (const key of failures.current.keys()) {
        if (key.startsWith(prefix)) failures.current.delete(key)
      }
      setSettingsRevision(revision => revision + 1)
    }
    const unsubscribePersonal = subscribePersonalStandIn(retryUpdatedDevice)
    const unsubscribeProject = subscribeStandInSettings(retryUpdatedDevice)
    return () => {
      unsubscribePersonal()
      unsubscribeProject()
    }
  }, [accountKey, userId])
  useEffect(() => {
    if (getDesktopWindowLabel() !== 'main' || !api || !identity || userId == null) return
    const assignments = (inbox?.items ?? []).flatMap(notification => {
      const { projectId, itemId, assignmentId } = notification.payload
      return notification.kind === 'issue_dispatch_assignment' &&
        projectId &&
        itemId &&
        assignmentId
        ? [{ id: notification.id, projectId, itemId, assignmentId }]
        : []
    })
    if (assignments.length === 0) return
    let active = true
    void identity()
      .then(local => {
        if (!active || !local) return
        const targets = new Set([local.deviceId])
        for (const device of devices ?? []) {
          if (device.status !== 'offline' && !workbenchDeviceMatchesId(device, local.deviceId)) {
            targets.add(device.device_id)
          }
        }
        for (const notification of assignments) {
          for (const deviceId of targets) {
            const key = `${accountKey}:${userId}:${deviceId}:${notification.id}`
            if (attempted.current.has(key)) continue
            const failure = failures.current.get(key)
            if (failure && failure.retryAt > Date.now()) {
              wakeAt(failure.retryAt)
              continue
            }
            attempted.current.add(key)
            console.info('[Stand-in] Forwarding assignment notification', {
              notificationId: notification.id,
              projectId: notification.projectId,
              issueId: notification.itemId,
              assignmentId: notification.assignmentId,
              userId,
              deviceId,
            })
            void api
              .notifyAssignment(
                notification.projectId,
                notification.itemId,
                notification.assignmentId,
                userId,
                deviceId
              )
              .then(() => failures.current.delete(key))
              .catch(error => {
                // Delivery is not acknowledged until the Executor accepts it.
                attempted.current.delete(key)
                const count = (failures.current.get(key)?.count ?? 0) + 1
                const retryAt = Date.now() + Math.min(5_000 * 2 ** Math.min(count - 1, 6), 300_000)
                failures.current.set(key, { count, retryAt })
                wakeAt(retryAt)
                console.error('[Stand-in] Assignment notification failed', {
                  notificationId: notification.id,
                  deviceId,
                  error,
                })
              })
          }
        }
      })
      .catch(error => console.error('[Stand-in] Executor identity unavailable', error))
    return () => {
      active = false
    }
  }, [inbox, api, identity, devices, userId, accountKey, settingsRevision])
}
