import {
  commitLocalStorageValue,
  readCommittedLocalStorageValue,
} from '@/desktop/localStoragePersistence'
import type { InteractionHistory } from './RuntimeInteractionsContext'
import { archiveInteraction, parseInteractionHistory } from './interactionStorage'
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
  onCommitted: (history: InteractionHistory[]) => void
): Promise<void> {
  await navigator.locks.request(key, async () => {
    const current = parseInteractionHistory(await readCommittedLocalStorageValue(key))
    const next = archiveInteraction(current, entry)
    if (next !== current) await commitLocalStorageValue(key, JSON.stringify(next))
    onCommitted(next)
  })
}
