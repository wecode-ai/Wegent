import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import type { InteractionHistory } from './RuntimeInteractionsContext'
import {
  archiveInteraction,
  readInteractionHistory,
  saveInteractionState,
} from './interactionStorage'
import {
  interactionSource,
  interactionOriginalScheme,
  type RuntimeInteraction,
} from './runtimeInteractions'

export function interactionHistoryEntry(
  item: RuntimeInteraction,
  answeredAt: number
): InteractionHistory {
  return {
    id: item.id,
    source: interactionSource(item),
    title: item.task.task.title,
    question: item.question,
    address: item.task.address,
    originalUrl: interactionOriginalScheme(item),
    sourceMessageIds: item.sourceMessageIds,
    answeredAt,
  }
}

/** Hold the account-scoped lock through queued storage and its durable acknowledgement. */
export async function persistInteractionArchive(
  key: string,
  entry: InteractionHistory,
  failedWrites: Map<string, InteractionHistory[] | null>,
  onCommitted: (history: InteractionHistory[]) => void
): Promise<void> {
  await navigator.locks.request(key, async () => {
    const current = failedWrites.get(key) ?? readInteractionHistory(key)
    const next = archiveInteraction(current, entry)
    let written = false
    try {
      if (next !== current || failedWrites.has(key)) {
        if (!saveInteractionState(key, next)) throw new Error('Could not save interaction history')
        written = true
      }
      await flushDesktopLocalStoragePersistence()
      failedWrites.delete(key)
    } catch (cause) {
      // Restore the visible snapshot before another item can acquire the archive lock.
      const restored = !written || saveInteractionState(key, current)
      failedWrites.set(key, restored ? null : current)
      throw cause
    }
    onCommitted(next)
  })
}
