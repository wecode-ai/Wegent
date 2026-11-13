import type { TaskSource } from './NotificationTaskSourceContext'
import { logInteractionLoadFailure } from './interactionDiagnostics'
import {
  collectRuntimeTaskReminderItems,
  type RuntimeTaskReminderItem,
} from '@/features/workbench/runtimeTaskReminders'
import { getWorkbenchDeviceIds } from '@/lib/workbench-device'

/**
 * Sidebar visibility never defines which authorized executions can ask for a
 * decision. The local aliases scope reminders without limiting discovery.
 */
export async function readInteractionTaskInventory(source: TaskSource): Promise<{
  items: RuntimeTaskReminderItem[]
  failedDevices: Set<string>
  failedRequests: Set<string>
  refreshedDevices: Set<string>
  localDeviceIds: Set<string>
  localIssueQuestionsPending?: boolean
}> {
  const api = source.services?.runtimeWorkApi
  if (!api)
    return {
      items: [],
      failedDevices: new Set(),
      failedRequests: new Set(),
      refreshedDevices: new Set(),
      localDeviceIds: new Set(),
    }
  const localIdentity = await source.services?.getLocalRuntimeSidebarIdentity?.().catch(error => {
    logInteractionLoadFailure('local-identity', error)
    return null
  })
  const localDeviceIds = new Set<string>()
  if (localIdentity) {
    localDeviceIds.add(localIdentity.deviceId)
    localDeviceIds.add(localIdentity.runtimeInstanceId)
    for (const device of source.devices ?? []) {
      if (
        device.device_id !== localIdentity.deviceId &&
        device.runtime_instance_id !== localIdentity.runtimeInstanceId
      )
        continue
      for (const deviceId of getWorkbenchDeviceIds(device)) localDeviceIds.add(deviceId)
    }
  }
  const devices: Array<string | undefined> = [
    ...new Set([
      ...(localIdentity ? [localIdentity.deviceId] : []),
      ...(source.devices
        ?.filter(device => ['online', 'busy'].includes(device.status))
        .map(device => device.device_id) ?? []),
    ]),
  ]
  if (!devices.length) devices.push(undefined)
  const items: RuntimeTaskReminderItem[] = []
  const refreshedDevices = new Set<string>()
  const failedRequests = new Set<string>()
  const failedDevices = new Set(
    source.devices
      ?.filter(
        device => device.status === 'offline' && device.device_id !== localIdentity?.deviceId
      )
      .map(device => device.device_id)
  )
  let index = 0
  let localIssueQuestionsPending: boolean | undefined
  await Promise.all(
    Array.from({ length: Math.min(4, devices.length) }, async () => {
      while (index < devices.length) {
        const deviceId = devices[index++]
        try {
          const work = await api.listRuntimeWork({
            pendingOnly: true,
            preferCached: true,
            deviceId,
          })
          const found = collectRuntimeTaskReminderItems(work)
          if (localIdentity ? deviceId === localIdentity.deviceId : deviceId == null) {
            localIssueQuestionsPending = work.localIssueQuestionsPending
          }
          items.push(...found)
          if (deviceId) refreshedDevices.add(deviceId)
          for (const item of found) refreshedDevices.add(item.address.deviceId)
        } catch (error) {
          logInteractionLoadFailure('inventory', error, { deviceId })
          failedDevices.add(deviceId ?? '')
          failedRequests.add(deviceId ?? '')
        }
      }
    })
  )
  return {
    items,
    failedDevices,
    failedRequests,
    refreshedDevices,
    localDeviceIds,
    localIssueQuestionsPending,
  }
}
