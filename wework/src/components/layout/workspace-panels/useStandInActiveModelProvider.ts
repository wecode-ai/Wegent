import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { StandInExecutorApi } from '@/api/standIn'
import { savedConversationProvider } from '@/features/workbench/runtimeModelSelection'
import type { ModelSelectionConfig, RuntimeTaskAddress } from '@/types/api'

export function activeModelProviderFromHandle(
  handle: Record<string, unknown> | null | undefined,
  threadId: string | null | undefined
): string | null {
  const value = handle?.activeModelProvider
  if (!value || typeof value !== 'object') return null
  const identity = value as Record<string, unknown>
  return identity.threadId === threadId && typeof identity.provider === 'string'
    ? identity.provider.trim() || null
    : null
}

/** Resolve only legacy stand-in sessions that have no saved provider identity. */
export function useStandInActiveModelProvider({
  enabled,
  api,
  address,
  threadId,
  selection,
  runtimeHandle,
}: {
  enabled: boolean
  api: StandInExecutorApi | undefined
  address: RuntimeTaskAddress | null
  threadId: string | null | undefined
  selection: ModelSelectionConfig | null | undefined
  runtimeHandle: Record<string, unknown> | null | undefined
}) {
  const storedProvider = activeModelProviderFromHandle(runtimeHandle, threadId)
  const savedProvider = storedProvider ?? savedConversationProvider(selection)
  const key =
    enabled && address && threadId
      ? JSON.stringify([address.deviceId, address.taskId, threadId])
      : ''
  const deviceId = address?.deviceId
  const taskId = address?.taskId
  const readTask = api?.readTask
  const resource = useMemo(
    () =>
      createAsyncResource<string | null>(
        key,
        async () => {
          const result = await readTask!.call(api, deviceId!, taskId!, {
            resolveActiveProvider: true,
          })
          const task = result.task
          return result.success && task && task.threadId === threadId
            ? activeModelProviderFromHandle(task.runtimeHandle, threadId)
            : null
        },
        { refreshOnSubscribe: true }
      ),
    [api, readTask, key, deviceId, taskId, threadId]
  )
  const canRead = Boolean(key && !savedProvider && readTask && deviceId && taskId && threadId)
  const query = useSyncExternalStore(
    canRead ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const provider = storedProvider ?? query.data ?? savedProvider
  const pending = Boolean(key && !provider)
  const failed = pending && query.settled && !query.data
  const refresh = useCallback(() => {
    if (canRead) void resource.reload()
  }, [resource, canRead])
  return { provider, pending, failed, refreshing: pending && query.status === 'loading', refresh }
}
