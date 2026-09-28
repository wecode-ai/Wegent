import { useEffect, useState } from 'react'
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
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{
    api: GoalApi
    addressesKey: string
    revision: number
    values: Record<string, GoalState>
  } | null>(null)
  const addressesKey = JSON.stringify([
    ...new Map(addresses.map(address => [addressKey(address), address])).values(),
  ])
  useEffect(() => {
    let active = true
    const requested: RuntimeTaskAddress[] = JSON.parse(addressesKey)
    void Promise.all(
      requested.map(async address => {
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
    ).then(entries => {
      if (active) setSnapshot({ api, addressesKey, revision, values: Object.fromEntries(entries) })
    })
    return () => {
      active = false
    }
  }, [api, addressesKey, revision, loadFailedText])
  const current =
    snapshot?.api === api &&
    snapshot.addressesKey === addressesKey &&
    snapshot.revision === revision
      ? snapshot.values
      : null
  return {
    get: (address: RuntimeTaskAddress) => current?.[addressKey(address)],
    retry: () => setRevision(value => value + 1),
  }
}
