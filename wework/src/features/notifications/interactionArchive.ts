import {
  commitLocalStorageValue,
  readCommittedLocalStorageValue,
} from '@/desktop/localStoragePersistence'
import type { InteractionHistory } from './RuntimeInteractionsContext'
import { createRequestId } from '@/lib/request-id'
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
    const raw = await readCommittedLocalStorageValue(key)
    let current: InteractionHistory[]
    try {
      current = parseInteractionHistory(raw)
    } catch (error) {
      if (!(error instanceof SyntaxError) || raw === null) throw error
      await commitLocalStorageValue(`${key}:recovery:${createRequestId('history')}`, raw)
      current = []
    }
    const next = archiveInteraction(current, entry)
    if (next !== current) await commitLocalStorageValue(key, JSON.stringify(next))
    onCommitted(next)
  })
}
