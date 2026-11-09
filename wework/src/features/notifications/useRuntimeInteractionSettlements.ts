import { useEffect, useRef } from 'react'
import {
  getRuntimeConversationMessages,
  runtimeConversationKey,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import { logInteractionLoadFailure } from './interactionDiagnostics'
import { settledRuntimeInteractionKeys, type RuntimeInteraction } from './runtimeInteractions'

/** Original task answers settle the inbox without waiting for persisted transcript polling. */
export function useRuntimeInteractionSettlements(
  pending: RuntimeInteraction[],
  settle: (item: RuntimeInteraction) => Promise<void>
) {
  const inFlight = useRef(new Set<string>())
  useEffect(() => {
    const tasks = new Map<string, RuntimeInteraction[]>()
    for (const item of pending) {
      // Issue questions remain owned by their versioned, authoritative inbox.
      if (item.sharedRequest || item.cached) continue
      const key = runtimeConversationKey(item.task.address)
      const items = tasks.get(key) ?? []
      items.push(item)
      tasks.set(key, items)
    }
    const unsubscribes = [...tasks.values()].map(items => {
      const address = items[0].task.address
      const update = () => {
        const settled = settledRuntimeInteractionKeys(getRuntimeConversationMessages(address))
        for (const item of items) {
          if (!settled.has(item.requestKey) || inFlight.current.has(item.id)) continue
          inFlight.current.add(item.id)
          void settle(item)
            .catch(error => logInteractionLoadFailure('archive', error, address))
            .finally(() => inFlight.current.delete(item.id))
        }
      }
      const unsubscribe = subscribeRuntimeConversation(address, update, {
        retainWhileSubscribed: false,
      })
      // The task may already have accepted the answer before discovery completes.
      update()
      return unsubscribe
    })
    return () => unsubscribes.forEach(unsubscribe => unsubscribe())
  }, [pending, settle])
}
