import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import type { AutomationApi } from '@/features/workbench/workbenchServices'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { WORKBENCH_AUTOMATIONS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'

export function useStandInProfileSchedules(
  api: AutomationApi | undefined,
  userId: number,
  roleId: string,
  deviceId?: string
) {
  const resource = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify([userId, roleId, deviceId]),
        async () => {
          const response = await api!.listAutomations()
          return response.items.filter(item => {
            const request = item.taskRequest
            return (
              Boolean(request?.standInCalendar) &&
              request?.standInOwner?.userId === userId &&
              request.standInOwner.roleId === roleId &&
              (!request.deviceId || request.deviceId === deviceId)
            )
          })
        },
        { refreshIntervalMs: 30_000, refreshOnSubscribe: true }
      ),
    [api, userId, roleId, deviceId]
  )
  const query = useSyncExternalStore(
    api ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const retry = () => {
    if (api) void resource.reload()
  }
  useDOMEvent('window', WORKBENCH_AUTOMATIONS_CHANGED_EVENT, retry, { enabled: Boolean(api) })
  return {
    items: query.data ?? [],
    error: query.status === 'error' ? getStandInErrorMessage(query.error) : undefined,
    loading: Boolean(api && !query.settled),
    retry,
  }
}
