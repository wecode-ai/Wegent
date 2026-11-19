import {
  getRuntimeConversationMessages,
  runtimeConversationKey,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import { logInteractionLoadFailure } from './interactionDiagnostics'
import { settledRuntimeInteractionKeys, type RuntimeInteraction } from './runtimeInteractions'

interface SettlementOwner {
  active(): boolean
  pending(): RuntimeInteraction[]
  settle(item: RuntimeInteraction): Promise<void>
}
interface ConversationWatch {
  key: string
  items: RuntimeInteraction[]
  stop?: () => void
}

/** Real conversation acceptance settles native requests without transcript polling. */
export function createRuntimeInteractionSettlements(owner: SettlementOwner) {
  const inFlight = new Set<string>()
  const watches = new Map<string, ConversationWatch>()
  let observed: RuntimeInteraction[] | undefined
  const update = (watch: ConversationWatch) => {
    if (!owner.active() || watches.get(watch.key) !== watch) return
    const address = watch.items[0].task.address
    const settled = settledRuntimeInteractionKeys(getRuntimeConversationMessages(address))
    for (const item of watch.items) {
      if (!settled.has(item.requestKey) || inFlight.has(item.id)) continue
      inFlight.add(item.id)
      void owner
        .settle(item)
        .catch(error => logInteractionLoadFailure('archive', error, address))
        .finally(() => inFlight.delete(item.id))
    }
  }
  return {
    synchronize() {
      if (!owner.active()) return
      const pending = owner.pending()
      if (pending === observed) return
      observed = pending
      const tasks = new Map<string, RuntimeInteraction[]>()
      for (const item of pending) {
        // Issue questions remain owned by their versioned, authoritative inbox.
        if (item.sharedRequest) continue
        const key = runtimeConversationKey(item.task.address)
        const items = tasks.get(key) ?? []
        items.push(item)
        tasks.set(key, items)
      }
      for (const [key, watch] of watches)
        if (!tasks.has(key)) {
          watch.stop?.()
          watches.delete(key)
        }
      for (const [key, items] of tasks) {
        let watch = watches.get(key)
        if (watch) watch.items = items
        else {
          watch = { key, items }
          watches.set(key, watch)
          const owned = watch
          watch.stop = subscribeRuntimeConversation(items[0].task.address, () => update(owned), {
            retainWhileSubscribed: false,
          })
        }
        // The task may already have accepted the answer before discovery completes.
        update(watch)
      }
    },
    disconnect() {
      for (const watch of watches.values()) watch.stop?.()
      watches.clear()
      observed = undefined
    },
  }
}
