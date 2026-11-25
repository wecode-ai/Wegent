import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import type { RuntimeWorkListResponse } from '@/types/api'

type RuntimeWorkApi = NonNullable<WorkbenchServices['runtimeWorkApi']>

export function standInProjectWorkspace(
  project: RuntimeWorkListResponse['projects'][number],
  deviceId: string
) {
  return project.deviceWorkspaces.find(
    workspace =>
      workspace.deviceId === deviceId &&
      workspace.available &&
      workspace.workspaceKind !== 'chat' &&
      workspace.workspaceSource !== 'remote'
  )
}

/** Keep environment reads and recovery independent of editable personal settings. */
export function useStandInRuntimeWork(
  api: RuntimeWorkApi | undefined,
  deviceId: string | undefined,
  enabled = true
) {
  const resource = useMemo(
    () =>
      api && deviceId
        ? createAsyncResource(deviceId, () => api.listRuntimeWork({ deviceId }), {
            failure: cause => reportStandInError('load_environment', cause, deviceId),
          })
        : null,
    [api, deviceId]
  )
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || !resource) return () => {}
      const unsubscribe = resource.subscribe(listener)
      if (resource.getSnapshot().status === 'ready') void resource.reload()
      return unsubscribe
    },
    [enabled, resource]
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const retryRuntimeWork = useCallback(() => {
    if (enabled) void resource?.reload()
  }, [enabled, resource])
  return {
    runtimeWork: snapshot.data ?? null,
    runtimeError:
      snapshot.error === undefined
        ? null
        : getStandInErrorMessage(snapshot.error, 'load_environment_failed'),
    retryRuntimeWork,
  }
}
