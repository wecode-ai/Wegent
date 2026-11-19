import { useMemo, useSyncExternalStore } from 'react'
import { boardRuntimeReadKey } from './boardRuntimeReadKey'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { ExecutorRuntimeClient } from '@/api/executorAccess'
import type { RuntimeGoal, RuntimeGoalGetResponse, RuntimeTaskAddress } from '@/types/api'

export type BoardRuntimeGoalLoader = ((
  address: RuntimeTaskAddress
) => Promise<RuntimeGoalGetResponse>) & { scope?: number | string }
type GoalResource = ReturnType<typeof createAsyncResource<RuntimeGoalGetResponse>>
const sources = new WeakMap<BoardRuntimeGoalLoader, Map<string, GoalResource>>()

export function createBoardRuntimeGoalLoader(
  api: Pick<ExecutorRuntimeClient, 'getRuntimeGoal'> | undefined,
  scope: number | string
): BoardRuntimeGoalLoader | undefined {
  if (!api) return undefined
  return Object.assign((address: RuntimeTaskAddress) => api.getRuntimeGoal({ address }), { scope })
}

function resourceFor(read: BoardRuntimeGoalLoader, address: RuntimeTaskAddress) {
  // Include the read authority and routing metadata; object field order does not define a session.
  const key = boardRuntimeReadKey([read.scope, address])
  let resources = sources.get(read)
  if (!resources) {
    resources = new Map()
    sources.set(read, resources)
  }
  let resource = resources.get(key)
  if (!resource) {
    resource = createAsyncResource(
      key,
      async signal => {
        await Promise.resolve()
        signal.throwIfAborted()
        return read(address)
      },
      {
        failure(error) {
          console.warn('[Wework project board] failed to load task goal', {
            deviceId: address.deviceId,
            taskId: address.taskId,
            error,
          })
        },
      }
    )
    resources.set(key, resource)
  }
  return resource
}

/** Cards and their progress panels share one scoped goal request and its actual response. */
export function useBoardRuntimeGoal(
  address: RuntimeTaskAddress | null,
  read: BoardRuntimeGoalLoader | undefined,
  {
    enabled = true,
    loaded = false,
    goal,
  }: { enabled?: boolean; loaded?: boolean; goal?: RuntimeGoal | null } = {}
) {
  const resource = useMemo(
    () => (address && read ? resourceFor(read, address) : null),
    [address, read]
  )
  const snapshot = useSyncExternalStore(
    enabled && !loaded && resource ? resource.subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const response = snapshot.data
  return {
    goal: loaded ? goal : response?.accepted ? response.goal : null,
    loading: enabled && !loaded && Boolean(resource) && !snapshot.settled,
    failed:
      enabled &&
      !loaded &&
      (snapshot.status === 'error' ||
        (snapshot.status === 'ready' && response?.accepted === false && Boolean(response.error))),
    retry: () => resource?.reload(),
  }
}
