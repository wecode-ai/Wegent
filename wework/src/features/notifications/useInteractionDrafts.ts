import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import type { InteractionHistory, InteractionReplyDraft } from './RuntimeInteractionsContext'
import {
  readInteractionDraftState,
  saveInteractionState,
  type InteractionDraftState,
} from './interactionStorage'

interface DraftMutation {
  state: InteractionDraftState
  save: boolean
  flush: boolean
  publish?: 'before' | 'after'
}

function draftText(value: InteractionDraftState[string] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.text
}

function withDraftText(
  state: InteractionDraftState,
  id: string,
  text: string
): InteractionDraftState {
  const next = { ...state }
  const previous = next[id]
  if (!text) delete next[id]
  else next[id] = typeof previous === 'object' ? { ...previous, text } : text
  return next
}

/** Storage is shared by every Wework window; mutate the latest map, never a stale snapshot. */
export function createInteractionDraftStore(accountKey: string) {
  const key = `wework.interactions:${accountKey}:drafts`
  const historyKey = `wework.interactions:${accountKey}:history`
  let values = readInteractionDraftState(key, historyKey)
  let active = true
  let revision = 0
  let pending = 0
  let syncAfterPending = false
  let writes = Promise.resolve()
  const pendingText = new Map<string, string>()
  const listeners = new Set<() => void>()
  const publish = (next: typeof values) => {
    if (JSON.stringify(next) === JSON.stringify(values)) return
    values = next
    listeners.forEach(listener => listener())
  }
  const refresh = () => {
    let next = readInteractionDraftState(key, historyKey)
    for (const [id, text] of pendingText) next = withDraftText(next, id, text)
    publish(next)
  }
  const commitPendingText = (state: InteractionDraftState) => {
    for (const [id, text] of pendingText) {
      if (text ? draftText(state[id]) === text : !(id in state)) pendingText.delete(id)
    }
  }
  const enqueue = (update: (latest: InteractionDraftState) => DraftMutation | null) => {
    revision += 1
    const operationRevision = revision
    pending += 1
    const operation = writes.then(async () => {
      await navigator.locks.request(key, async () => {
        const latest = readInteractionDraftState(key, historyKey)
        const mutation = update(latest)
        if (!mutation) return
        if (mutation.save && !saveInteractionState(key, mutation.state))
          throw new Error('Could not save interaction draft')
        if (mutation.save) commitPendingText(mutation.state)
        const shouldPublish =
          active && operationRevision === revision && (mutation.save || mutation.publish)
        if (shouldPublish && mutation.publish !== 'after') publish(mutation.state)
        if (mutation.flush) await flushDesktopLocalStoragePersistence()
        if (shouldPublish && mutation.publish === 'after') publish(mutation.state)
      })
    })
    writes = operation.catch(() => undefined)
    const complete = () => {
      pending -= 1
      if (pending === 0 && syncAfterPending) {
        syncAfterPending = false
        if (active) refresh()
      }
    }
    void operation.then(complete, complete)
    return operation
  }
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
      refresh()
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key && event.key !== null) return
        if (pending) syncAfterPending = true
        else refresh()
      }
      window.addEventListener('storage', onStorage)
      return () => {
        active = false
        window.removeEventListener('storage', onStorage)
      }
    },
    setDraft(id: string, text: string) {
      if (!active) return
      pendingText.set(id, text)
      publish(withDraftText(values, id, text))
      const operation = enqueue(latest => ({
        state: withDraftText(latest, id, text),
        save: true,
        flush: false,
      }))
      void operation.catch(error =>
        console.error('[Wework] Could not save interaction draft', error)
      )
    },
    /** Test and handoff barrier for queued mutations of this store. */
    flush: () => writes,
    async retainDraft(interaction: InteractionHistory, nativeReply?: { id: string; text: string }) {
      if (!active) throw new Error('Interaction account changed')
      let appliedUnsaved: string | undefined
      await enqueue(latest => {
        const previous = latest[interaction.id]
        const retained = typeof previous === 'object' ? previous : undefined
        // An acknowledgement retry must not replace newer edits.
        const alreadyRetained = nativeReply && retained?.nativeReplyIds.includes(nativeReply.id)
        const unsaved = pendingText.get(interaction.id)
        const text =
          unsaved !== undefined
            ? unsaved || (nativeReply && !alreadyRetained ? nativeReply.text : '')
            : alreadyRetained && retained
              ? retained.text
              : nativeReply
                ? nativeReply.text
                : draftText(previous)
        if (!text) {
          // A native reply must never be acknowledged without a recoverable copy.
          if (nativeReply) throw new Error('Native interaction reply has no recoverable text')
          return null
        }
        appliedUnsaved = unsaved
        const entry: InteractionReplyDraft = {
          text,
          interaction,
          nativeReplyIds: [
            ...new Set([
              ...(retained?.nativeReplyIds ?? []),
              ...(nativeReply ? [nativeReply.id] : []),
            ]),
          ],
        }
        const next = { ...latest, [interaction.id]: entry }
        const unchanged = JSON.stringify(entry) === JSON.stringify(previous)
        // Retrying a native acknowledgement still waits for the existing text to be durable.
        if (unchanged && !nativeReply)
          return { state: latest, save: false, flush: false, publish: 'before' }
        return { state: next, save: !unchanged, flush: true, publish: 'before' }
      })
      if (appliedUnsaved !== undefined && pendingText.get(interaction.id) === appliedUnsaved)
        pendingText.delete(interaction.id)
    },
    async discardDraft(id: string): Promise<boolean> {
      if (!active) return false
      try {
        await enqueue(latest => {
          const exists = id in latest
          const next = { ...latest }
          delete next[id]
          return { state: next, save: exists, flush: true, publish: 'after' }
        })
        pendingText.delete(id)
        refresh()
        return true
      } catch (error) {
        console.error('[Wework] Could not discard interaction draft', error)
        return false
      }
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
  const store = useMemo(() => createInteractionDraftStore(accountKey), [accountKey])
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
    discardDraft: store.discardDraft,
    retainDraft: store.retainDraft,
    retainedReply: store.retainedReply,
  }
}
