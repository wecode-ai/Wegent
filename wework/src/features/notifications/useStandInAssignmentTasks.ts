import { useEffect, useMemo, useState } from 'react'
import type { WeworkInbox } from '@/api/notifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { TaskSource } from './NotificationTaskSourceContext'
import { getWorkbenchDeviceIds } from '@/lib/workbench-device'

const EMPTY_ITEMS: RuntimeTaskReminderItem[] = []

/** The sidebar is a visibility projection, not the history of handled assignments. */
export function useStandInAssignmentTasks(
  inbox: WeworkInbox | null,
  source: TaskSource | null,
  accountKey: string,
  enabled: boolean
) {
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
      .filter(device => device.status !== 'offline')
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
    error?: string
  } | null>(null)
  const available = enabled && api && identity && userId != null && assignments !== '[]'

  useEffect(() => {
    if (!available) return
    let active = true
    void (async () => {
      const local = await identity()
      if (!local) throw new Error('Stand-in executor is unavailable')
      const online: Array<{ id: string; aliases: string[] }> = JSON.parse(devices)
      const targets = new Set<string>([
        local.deviceId,
        ...online
          .filter(device => !device.aliases.includes(local.deviceId))
          .map(device => device.id),
      ])
      const results = await Promise.allSettled(
        [...targets].map(async deviceId => {
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
        })
      )
      if (!active) return
      const failure = results.find(result => result.status === 'rejected')
      setLoaded({
        scope,
        items: results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])),
        error: failure?.status === 'rejected' ? getStandInErrorMessage(failure.reason) : undefined,
      })
    })().catch(cause => {
      if (active) setLoaded({ scope, items: [], error: getStandInErrorMessage(cause) })
    })
    return () => {
      active = false
    }
  }, [available, api, identity, userId, assignments, devices, scope, inbox, visibleKeys])

  const current = available && loaded?.scope === scope ? loaded : null
  return {
    items: current?.items ?? EMPTY_ITEMS,
    pending: Boolean(available && !current),
    error: current?.error,
  }
}
