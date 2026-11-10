import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import type { InteractionHistory, InteractionReplyDraft } from './RuntimeInteractionsContext'
import { readInteractionDraftState, saveInteractionState } from './interactionStorage'

function createDraftStore(accountKey: string) {
  const key = `wework.interactions:${accountKey}:drafts`
  let values = readInteractionDraftState(key, `wework.interactions:${accountKey}:history`)
  let active = true
  const listeners = new Set<() => void>()
  const publish = (next: typeof values) => {
    values = next
    listeners.forEach(listener => listener())
  }
  const persist = () => saveInteractionState(key, values)
  return {
    getSnapshot: () => values,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    activate() {
      active = true
      persist()
      return () => {
        active = false
      }
    },
    setDraft(id: string, text: string) {
      if (!active) return
      const next = { ...values }
      const previous = next[id]
      if (!text) delete next[id]
      else next[id] = typeof previous === 'object' ? { ...previous, text } : text
      publish(next)
      persist()
    },
    async retainDraft(interaction: InteractionHistory, nativeReply?: { id: string; text: string }) {
      if (!active) throw new Error('Interaction account changed')
      const previous = values[interaction.id]
      const retained = typeof previous === 'object' ? previous : undefined
      // An acknowledgement retry must not replace newer edits.
      const alreadyRetained = nativeReply && retained?.nativeReplyIds.includes(nativeReply.id)
      const text =
        alreadyRetained && retained
          ? retained.text
          : (nativeReply?.text ?? (typeof previous === 'string' ? previous : retained?.text))
      if (!text) return
      publish({
        ...values,
        [interaction.id]: {
          text,
          interaction,
          nativeReplyIds: [
            ...new Set([
              ...(retained?.nativeReplyIds ?? []),
              ...(nativeReply ? [nativeReply.id] : []),
            ]),
          ],
        },
      })
      if (!persist()) throw new Error('Could not save interaction draft')
      await flushDesktopLocalStoragePersistence()
    },
    retainedReply: (id: string) =>
      Object.values(values).find(
        (value): value is InteractionReplyDraft =>
          typeof value === 'object' && value.nativeReplyIds.includes(id)
      ),
  }
}

/** Account-owned drafts publish input edits synchronously and expose explicit durable transfers. */
export function useInteractionDrafts(accountKey: string) {
  const store = useMemo(() => createDraftStore(accountKey), [accountKey])
  const values = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    // Upgrade old string drafts while their handled-history metadata still exists.
    return store.activate()
  }, [store])
  return {
    drafts: Object.fromEntries(
      Object.entries(values).map(([id, value]) => [
        id,
        typeof value === 'string' ? value : value.text,
      ])
    ),
    replyDrafts: Object.values(values).filter(
      (value): value is InteractionReplyDraft => typeof value === 'object'
    ),
    setDraft: store.setDraft,
    retainDraft: store.retainDraft,
    retainedReply: store.retainedReply,
  }
}
