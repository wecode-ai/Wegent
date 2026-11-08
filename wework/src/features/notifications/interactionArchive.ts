import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import type { InteractionHistory } from './RuntimeInteractionsContext'
import {
  archiveInteraction,
  readInteractionHistory,
  saveInteractionState,
} from './interactionStorage'

/** Hold the account-scoped lock through queued storage and its durable acknowledgement. */
export async function persistInteractionArchive(
  key: string,
  entry: InteractionHistory,
  failedWrites: Set<string>,
  onCommitted: (history: InteractionHistory[]) => void
): Promise<void> {
  await navigator.locks.request(key, async () => {
    const current = readInteractionHistory(key)
    const next = archiveInteraction(current, entry)
    try {
      if ((next !== current || failedWrites.has(key)) && !saveInteractionState(key, next))
        throw new Error('Could not save interaction history')
      await flushDesktopLocalStoragePersistence()
      failedWrites.delete(key)
    } catch (cause) {
      failedWrites.add(key)
      throw cause
    }
    onCommitted(next)
  })
}
