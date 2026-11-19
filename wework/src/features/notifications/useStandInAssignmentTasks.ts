import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
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
  const available = Boolean(enabled && api && identity && userId != null && assignments !== '[]')
  const resource = useMemo(
    () =>
      createAsyncResource(
        scope.accountKey,
        async signal => {
          const { api, identity, userId, devices, assignments } = scope
          if (!api || !identity || userId == null)
            throw new Error('Executor identity is unavailable')
          const local = await identity()
          signal.throwIfAborted()
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
                const response = await api.assignmentTasks(
                  userId,
                  deviceId,
                  JSON.parse(assignments)
                )
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
          const failureIndex = results.findIndex(result => result.status === 'rejected')
          const failure = results[failureIndex]
          return {
            items: results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])),
            error:
              failure?.status === 'rejected'
                ? { cause: failure.reason, deviceId: targets[failureIndex] }
                : undefined,
          }
        },
        { refreshOnSubscribe: true }
      ),
    [scope]
  )
  const version = useMemo(() => ({ inbox, visibleKeys }), [inbox, visibleKeys])
  const subscribe = useCallback(
    (notify: () => void) => resource.subscribe(notify, version),
    [resource, version]
  )
  const query = useSyncExternalStore(
    available ? subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const current = available ? query.data : undefined
  const failure: { cause: unknown; deviceId?: string } | undefined = available
    ? query.status === 'error'
      ? { cause: query.error }
      : current?.error
    : undefined
  return {
    items: current?.items ?? EMPTY_ITEMS,
    pending: available && !current && (query.status === 'idle' || query.status === 'loading'),
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
