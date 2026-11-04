import { useEffect, useMemo, useState } from 'react'
import type { WeworkInbox } from '@/api/notifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import { isAppDevice, isUsableDevice } from '@/lib/device-capabilities'
import type { TaskSource } from './NotificationTaskSourceContext'
import { getWorkbenchDeviceIds } from '@/lib/workbench-device'
import { useTranslation } from '@/hooks/useTranslation'

const EMPTY_ITEMS: RuntimeTaskReminderItem[] = []

/** The sidebar is a visibility projection, not the history of handled assignments. */
export function useStandInAssignmentTasks(
  inbox: WeworkInbox | null,
  source: TaskSource | null,
  accountKey: string,
  enabled: boolean
) {
  const { t } = useTranslation('common')
  const api = source?.services?.standInApi
  const identity = source?.services?.getLocalRuntimeSidebarIdentity
  const userId = source?.userId
  const assignments = JSON.stringify(
    (inbox?.items ?? []).flatMap(({ kind, payload }) =>
      kind === 'issue_dispatch_assignment' &&
      payload.projectId &&
      payload.itemId &&
      payload.humanAssignmentId
        ? [
            {
              projectId: payload.projectId,
              itemId: payload.itemId,
              humanAssignmentId: payload.humanAssignmentId,
            },
          ]
        : []
    )
  )
  const devices = JSON.stringify(
    (source?.devices ?? [])
      .filter(device => isUsableDevice(device) && !isAppDevice(device))
      .map(device => ({ id: device.device_id, aliases: getWorkbenchDeviceIds(device) }))
  )
  const visibleKeys = JSON.stringify(source?.items.map(item => item.key) ?? [])
  // Inbox and sidebar refreshes revalidate this scope without hiding resolved history.
  const scope = useMemo(
    () => ({ accountKey, userId, api, identity, assignments, devices }),
    [accountKey, userId, api, identity, assignments, devices]
  )
  const [loaded, setLoaded] = useState<{
    scope: typeof scope
    items: RuntimeTaskReminderItem[]
    error?: { cause: unknown; deviceId?: string }
  } | null>(null)
  const available = enabled && api && identity && userId != null && assignments !== '[]'

  useEffect(() => {
    if (!available) return
    let active = true
    void (async () => {
      const local = await identity()
      if (!local) throw new Error('Executor identity is unavailable')
      const online: Array<{ id: string; aliases: string[] }> = JSON.parse(devices)
      // Other app devices cannot serve this RPC over the cloud relay.
      const targets = [
        ...new Set([
          local.deviceId,
          ...online
            .filter(device => !device.aliases.includes(local.deviceId))
            .map(device => device.id),
        ]),
      ]
      const results = await Promise.allSettled(
        targets.map(async deviceId => {
          try {
            const response = await api.assignmentTasks(userId, deviceId, JSON.parse(assignments))
            return response.items.map(task => ({
              key: `${deviceId}\0${task.taskId}`,
              address: { deviceId, taskId: task.taskId },
              task,
              workspace: {
                deviceId,
                available: true,
                workspacePath: task.workspacePath,
                tasks: [task],
              },
              projectName: '',
            }))
          } catch (cause) {
            reportStandInError('lookup_assignment_tasks', cause, deviceId)
            throw cause
          }
        })
      )
      if (!active) return
      const failureIndex = results.findIndex(result => result.status === 'rejected')
      const failure = results[failureIndex]
      setLoaded({
        scope,
        items: results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])),
        error:
          failure?.status === 'rejected'
            ? { cause: failure.reason, deviceId: targets[failureIndex] }
            : undefined,
      })
    })().catch(cause => {
      if (active) setLoaded({ scope, items: [], error: { cause } })
    })
    return () => {
      active = false
    }
  }, [available, api, identity, userId, assignments, devices, scope, inbox, visibleKeys])

  const current = available && loaded?.scope === scope ? loaded : null
  const failure = current?.error
  return {
    items: current?.items ?? EMPTY_ITEMS,
    pending: Boolean(available && !current),
    error: failure
      ? failure.deviceId
        ? t('standIn.errors.assignment_lookup_failed', {
            deviceId: failure.deviceId,
            error: getStandInErrorMessage(failure.cause),
          })
        : getStandInErrorMessage(failure.cause)
      : undefined,
  }
}
