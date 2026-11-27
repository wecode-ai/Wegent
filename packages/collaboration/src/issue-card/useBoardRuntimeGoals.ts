import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimeGoal } from '@wegent/chat-core/runtime-stream-types'
import type { createRuntimeConversationApi } from '@wegent/chat-core/runtime-conversation-api'

type GoalApi = Pick<ReturnType<typeof createRuntimeConversationApi>, 'getRuntimeGoal'>
type GoalState = { goal: RuntimeGoal | null; error: string | null }
const addressKey = (address: RuntimeTaskAddress) =>
  JSON.stringify([address.deviceId, address.taskId])

/** Address-scoped goal data for the shared board title and progress popup. */
export function useBoardRuntimeGoals(
  api: GoalApi,
  addresses: RuntimeTaskAddress[],
  loadFailedText: string
) {
  const addressesKey = JSON.stringify([
    ...new Map(addresses.map(address => [addressKey(address), address])).values(),
  ])
  const resource = useMemo(
    () =>
      createAsyncResource(addressesKey, async () => {
        const requested: RuntimeTaskAddress[] = JSON.parse(addressesKey)
        const entries = await Promise.all(
          requested.map(async (address): Promise<readonly [string, GoalState]> => {
            try {
              const response = await api.getRuntimeGoal({ address })
              if (!response.accepted) throw new Error(response.error || loadFailedText)
              return [addressKey(address), { goal: response.goal, error: null }] as const
            } catch (cause) {
              return [
                addressKey(address),
                { goal: null, error: cause instanceof Error ? cause.message : String(cause) },
              ] as const
            }
          })
        )
        return Object.fromEntries(entries)
      }),
    [api, addressesKey, loadFailedText]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const current = snapshot.status === 'ready' ? snapshot.data : null
  const retry = useCallback(() => {
    void resource.reload()
  }, [resource])
  return {
    get: (address: RuntimeTaskAddress) => current?.[addressKey(address)],
    retry,
  }
}
