import type { WeworkInbox } from '@/api/notifications'
import { subscribePersonalStandIn } from '@/api/personalStandIn'
import { subscribeStandInSettings } from '@/api/standIn'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { workbenchDeviceMatchesId } from '@/lib/workbench-device'
import type { TaskSource } from './NotificationTaskSourceContext'

// Leave room on the shared local HTTP transport for interactive requests.
const MAX_CONCURRENT_ASSIGNMENT_DELIVERIES = 2

function retryDelay(failures: number) {
  return Math.min(5_000 * 2 ** Math.min(failures - 1, 6), 300_000)
}

interface AssignmentObservation {
  inbox: WeworkInbox | null
  source: TaskSource | null
  userId: number | null
}
interface DeliveryReceipt {
  userId: number
  deviceId: string
  status: 'pending' | 'accepted' | 'failed'
  failures: number
  retryAt: number
  reconsiderAfterPending?: boolean
}

function assignmentNotifications(inbox: WeworkInbox | null | undefined) {
  return (inbox?.items ?? []).flatMap(notification => {
    const { projectId, itemId, assignmentId } = notification.payload
    return notification.kind === 'issue_dispatch_assignment' && projectId && itemId && assignmentId
      ? [{ id: notification.id, projectId, itemId, assignmentId }]
      : []
  })
}

/** Executor acceptance receipts belong to the inbox owner, not a component lifetime. */
export function createStandInAssignmentDelivery(accountKey: string) {
  const receipts = new Map<string, DeliveryReceipt>()
  let input: AssignmentObservation | undefined
  let observing = false
  let activeDeliveries = 0
  let readRevision = 0
  let pendingIdentity: object | undefined
  let identityFailures = 0
  let identityRetryAt = 0
  let retryAfterIdentity = false
  let releasePersonal: (() => void) | undefined
  let releaseProject: (() => void) | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDeadline: number | undefined

  function retryCurrentAssignments() {
    if (pendingIdentity) {
      retryAfterIdentity = true
      return
    }
    reconcile()
  }
  function wakeAt(deadline: number) {
    if (!observing || (retryDeadline != null && retryDeadline <= deadline)) return
    clearTimeout(retryTimer)
    retryDeadline = deadline
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined
        retryDeadline = undefined
        retryCurrentAssignments()
      },
      Math.max(0, deadline - Date.now())
    )
  }
  function reconsiderDevice(settings: { userId: number; executionDeviceId: string }) {
    if (!observing || settings.userId !== input?.userId) return
    for (const [key, receipt] of receipts) {
      if (receipt.userId !== settings.userId || receipt.deviceId !== settings.executionDeviceId)
        continue
      // Reconsider the latest settings after the already-issued RPC settles.
      if (receipt.status === 'pending') receipt.reconsiderAfterPending = true
      else receipts.delete(key)
    }
    retryCurrentAssignments()
  }
  function reconcile() {
    const current = input
    const api = current?.source?.services?.standInApi
    const identity = current?.source?.services?.getLocalRuntimeSidebarIdentity
    const userId = current?.userId
    if (
      !observing ||
      activeDeliveries >= MAX_CONCURRENT_ASSIGNMENT_DELIVERIES ||
      pendingIdentity ||
      getDesktopWindowLabel() !== 'main' ||
      !api ||
      !identity ||
      userId == null
    )
      return
    const assignments = assignmentNotifications(current?.inbox)
    if (!assignments.length) return
    if (identityRetryAt > Date.now()) {
      wakeAt(identityRetryAt)
      return
    }
    const request = {}
    const revision = readRevision
    pendingIdentity = request
    void identity()
      .then(local => {
        if (pendingIdentity !== request || revision !== readRevision || !observing) return
        if (!local) throw new Error('Local Executor identity is unavailable')
        identityFailures = 0
        identityRetryAt = 0
        // Observer metadata can take over an in-flight identity read in the same commit.
        const latest = input
        if (
          !latest ||
          latest.userId !== userId ||
          latest.source?.services?.standInApi !== api ||
          latest.source?.services?.getLocalRuntimeSidebarIdentity !== identity
        )
          return
        const targets = new Set([local.deviceId])
        for (const device of latest.source?.devices ?? []) {
          if (device.status !== 'offline' && !workbenchDeviceMatchesId(device, local.deviceId))
            targets.add(device.device_id)
        }
        const assignments = assignmentNotifications(latest.inbox)
        for (const notification of assignments)
          for (const deviceId of targets) {
            if (
              !observing ||
              revision !== readRevision ||
              input?.userId !== userId ||
              input.source?.services?.standInApi !== api
            )
              return
            const key = JSON.stringify([accountKey, userId, deviceId, notification.id])
            const previous = receipts.get(key)
            if (previous && previous.status !== 'failed') continue
            if (previous && previous.retryAt > Date.now()) {
              wakeAt(previous.retryAt)
              continue
            }
            const receipt: DeliveryReceipt = {
              userId,
              deviceId,
              status: 'pending',
              failures: previous?.failures ?? 0,
              retryAt: 0,
            }
            receipts.set(key, receipt)
            activeDeliveries++
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
              .then(() => {
                if (receipts.get(key) !== receipt) return
                if (receipt.reconsiderAfterPending) {
                  receipts.delete(key)
                  return
                }
                receipt.status = 'accepted'
                receipt.failures = 0
              })
              .catch(error => {
                if (receipts.get(key) !== receipt) return
                console.error('[Stand-in] Assignment notification failed', {
                  notificationId: notification.id,
                  deviceId,
                  error,
                })
                if (receipt.reconsiderAfterPending) {
                  receipts.delete(key)
                  return
                }
                receipt.status = 'failed'
                receipt.failures++
                receipt.retryAt = Date.now() + retryDelay(receipt.failures)
                if (observing && input?.userId === userId) wakeAt(receipt.retryAt)
              })
              .finally(() => {
                activeDeliveries--
                retryCurrentAssignments()
              })
            if (activeDeliveries >= MAX_CONCURRENT_ASSIGNMENT_DELIVERIES) return
          }
      })
      .catch(error => {
        if (!observing || revision !== readRevision || pendingIdentity !== request) return
        console.error('[Stand-in] Executor identity unavailable', error)
        identityRetryAt = Date.now() + retryDelay(++identityFailures)
        wakeAt(identityRetryAt)
      })
      .finally(() => {
        if (pendingIdentity !== request) return
        pendingIdentity = undefined
        if (retryAfterIdentity) {
          retryAfterIdentity = false
          reconcile()
        }
      })
  }
  return {
    observe(next: AssignmentObservation) {
      const previous = input
      if (
        previous &&
        (previous.userId !== next.userId ||
          previous.source?.services?.standInApi !== next.source?.services?.standInApi ||
          previous.source?.services?.getLocalRuntimeSidebarIdentity !==
            next.source?.services?.getLocalRuntimeSidebarIdentity)
      ) {
        readRevision++
        retryAfterIdentity = false
        pendingIdentity = undefined
        identityFailures = 0
        identityRetryAt = 0
        clearTimeout(retryTimer)
        retryTimer = undefined
        retryDeadline = undefined
      }
      input = next
      observing = true
      if (!releasePersonal) releasePersonal = subscribePersonalStandIn(reconsiderDevice)
      if (!releaseProject) releaseProject = subscribeStandInSettings(reconsiderDevice)
      reconcile()
    },
    suspend() {
      observing = false
    },
    release() {
      observing = false
      readRevision++
      retryAfterIdentity = false
      pendingIdentity = undefined
      identityFailures = 0
      identityRetryAt = 0
      clearTimeout(retryTimer)
      retryTimer = undefined
      retryDeadline = undefined
      releasePersonal?.()
      releasePersonal = undefined
      releaseProject?.()
      releaseProject = undefined
    },
  }
}
