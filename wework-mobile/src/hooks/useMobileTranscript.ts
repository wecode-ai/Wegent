import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import type { ChatAction } from '@/domain/chatActions'
import { MobileConversation } from '@/domain/mobileConversation'
import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import type { RuntimeStream } from '@/services/runtimeStream'
import { recordMobileDiagnostic } from '@/services/mobileDiagnostics'
import type { ChatMessage, RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/runtime'
import type { RuntimeConversationTurn } from '../../../packages/chat-core/src/runtime-conversation'

// Match the PC conversation cache bounds; snapshots remain in memory only.
const MAX_CONVERSATIONS = 50
const IDLE_TTL_MS = 5 * 60 * 1000

interface ConversationSnapshot {
  readonly messages: ChatMessage[]
  conversation: MobileConversation
  beforeCursor: string | null
  title?: string | null
  loaded: boolean
  touchedAt: number
  paginationGeneration: number
  pending?: Promise<RuntimeTranscriptResponse | null>
  repair?: Promise<RuntimeTranscriptResponse | null>
  repairRevision?: number
  older?: Promise<void>
}

export function useMobileTranscript(
  stream: RuntimeStream,
  currentAddress: RefObject<RuntimeTaskAddress | null>,
  onError: (
    error: string,
    address: RuntimeTaskAddress,
    page?: 'older',
    retry?: () => Promise<unknown>
  ) => void,
  observeRead?: (
    address: RuntimeTaskAddress,
    page?: 'older'
  ) => (response: RuntimeTranscriptResponse) => void
) {
  const entries = useRef(new Map<string, ConversationSnapshot>())
  const draft = useRef(new MobileConversation())
  const messagesRef = useRef<ChatMessage[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [hasMoreMessagesBefore, setHasMoreMessagesBefore] = useState(false)
  const [loadingMoreMessagesBefore, setLoadingMoreMessagesBefore] = useState(false)
  const readRevision = useRef(0)

  useEffect(() => {
    recordMobileDiagnostic('[MobileTranscript] View', {
      messages: messages.length,
      loading,
      hasMore: hasMoreMessagesBefore,
    })
  }, [messages.length, loading, hasMoreMessagesBefore])

  const entryFor = useCallback((address: RuntimeTaskAddress): ConversationSnapshot => {
    const key = runtimeTaskKey(address)
    let entry = entries.current.get(key)
    if (!entry) {
      entry = {
        conversation: new MobileConversation(address),
        get messages() {
          return this.conversation.messages
        },
        beforeCursor: null,
        loaded: false,
        touchedAt: Date.now(),
        paginationGeneration: 0,
      }
      entries.current.set(key, entry)
      while (entries.current.size > MAX_CONVERSATIONS) {
        const oldest = entries.current.keys().next().value
        if (oldest === undefined) break
        entries.current.delete(oldest)
      }
    }
    return entry
  }, [])

  const publish = useCallback(
    (address: RuntimeTaskAddress, entry: ConversationSnapshot) => {
      const key = runtimeTaskKey(address)
      if (entries.current.get(key) !== entry) return
      if (!currentAddress.current || runtimeTaskKey(currentAddress.current) !== key) return
      messagesRef.current = entry.messages
      setMessages(entry.messages)
      setHistoryLoaded(entry.loaded)
      setHasMoreMessagesBefore(Boolean(entry.beforeCursor))
      setLoadingMoreMessagesBefore(Boolean(entry.older))
    },
    [currentAddress]
  )

  const activate = useCallback(
    (address: RuntimeTaskAddress, options?: { adoptDraft?: boolean }) => {
      const key = runtimeTaskKey(address)
      for (const [candidate, entry] of entries.current) {
        const running = entry.messages.some(message =>
          ['pending', 'streaming'].includes(message.status)
        )
        if (
          !entry.pending &&
          !entry.older &&
          !running &&
          Date.now() - entry.touchedAt > IDLE_TTL_MS
        )
          entries.current.delete(candidate)
      }
      const entry = entryFor(address)
      if (options?.adoptDraft) {
        entry.conversation = draft.current
        entry.conversation.bind(address)
        draft.current = new MobileConversation()
      }
      entries.current.delete(key)
      entries.current.set(key, entry)
      entry.touchedAt = Date.now()
      recordMobileDiagnostic('[MobileTranscript] Activate', {
        messages: entry.messages.length,
        loaded: entry.loaded,
        pending: Boolean(entry.pending),
      })
      publish(address, entry)
      setLoading(!entry.loaded && entry.messages.length === 0)
      return entry.title
    },
    [entryFor, publish]
  )

  const reset = useCallback(() => {
    draft.current = new MobileConversation()
    messagesRef.current = []
    setMessages([])
    setLoading(false)
    setHistoryLoaded(false)
    setHasMoreMessagesBefore(false)
    setLoadingMoreMessagesBefore(false)
  }, [])

  const fail = useCallback(
    (address: RuntimeTaskAddress, error: string) => {
      if (
        !currentAddress.current ||
        runtimeTaskKey(currentAddress.current) !== runtimeTaskKey(address)
      )
        return
      setLoading(false)
      onError(error, address)
    },
    [currentAddress, onError]
  )

  const rename = useCallback((previous: RuntimeTaskAddress, next: RuntimeTaskAddress) => {
    const previousKey = runtimeTaskKey(previous)
    const nextKey = runtimeTaskKey(next)
    if (previousKey === nextKey) return
    const entry = entries.current.get(previousKey)
    if (!entry) return
    entries.current.delete(previousKey)
    entry.pending = undefined
    entry.repair = undefined
    entry.older = undefined
    entry.paginationGeneration += 1
    entry.conversation.endHydration()
    entry.conversation.bind(next)
    entries.current.set(nextKey, entry)
  }, [])

  const dispatchToAddress = useCallback(
    (address: RuntimeTaskAddress, action: ChatAction) => {
      const entry = entryFor(address)
      entry.conversation.dispatch(action)
      entry.touchedAt = Date.now()
      publish(address, entry)
    },
    [entryFor, publish]
  )

  const dispatchMessages = useCallback(
    (action: ChatAction) => {
      const address = currentAddress.current
      if (address) return dispatchToAddress(address, action)
      draft.current.dispatch(action)
      messagesRef.current = draft.current.messages
      setMessages(messagesRef.current)
    },
    [currentAddress, dispatchToAddress]
  )

  const readMessages = useCallback(
    (address: RuntimeTaskAddress) => entryFor(address).messages,
    [entryFor]
  )

  const reloadTranscript = useCallback(
    (address: RuntimeTaskAddress): Promise<RuntimeTranscriptResponse | null> => {
      const entry = entryFor(address)
      if (entry.pending) return entry.pending
      const read = ++readRevision.current
      const diagnostic = (phase: string, details: () => Record<string, unknown> = () => ({})) =>
        recordMobileDiagnostic(`[MobileTranscript] ${phase}`, () => ({
          read,
          retained: entries.current.get(runtimeTaskKey(address)) === entry,
          active: Boolean(
            currentAddress.current &&
            runtimeTaskKey(currentAddress.current) === runtimeTaskKey(address)
          ),
          messages: entry.messages.length,
          ...details(),
        }))
      diagnostic('Read started')
      if (
        currentAddress.current &&
        runtimeTaskKey(currentAddress.current) === runtimeTaskKey(address)
      )
        setLoading(!entry.loaded && entry.messages.length === 0)
      entry.conversation.beginHydration()
      const receive = observeRead?.(address)
      const request = stream
        .getTranscript(address)
        .then(transcript => {
          diagnostic('Read received', () => ({ receivedMessages: transcript.messages.length }))
          if (entries.current.get(runtimeTaskKey(address)) !== entry) return null
          receive?.(transcript)
          const resetPagination = entry.conversation.hydrate(transcript, entry.loaded)
          if (!entry.loaded || resetPagination) {
            entry.beforeCursor = transcript.beforeCursor ?? null
            entry.paginationGeneration += 1
            entry.older = undefined
          }
          entry.loaded = true
          entry.title = transcript.title
          entry.touchedAt = Date.now()
          diagnostic('Hydrated', () => ({
            tailLength: entry.messages.at(-1)?.content.length ?? 0,
            ...settledTurnToolCounts(transcript.turns ?? [], entry.conversation.turns),
          }))
          publish(address, entry)
          return transcript
        })
        .catch(cause => {
          diagnostic('Read failed', () => ({
            errorType: cause instanceof Error ? cause.name : typeof cause,
          }))
          if (entries.current.get(runtimeTaskKey(address)) !== entry) return null
          onError(cause instanceof Error ? cause.message : String(cause), address)
          throw cause
        })
        .finally(() => {
          if (entry.pending !== request) return
          entry.pending = undefined
          entry.conversation.endHydration()
          if (
            entries.current.get(runtimeTaskKey(address)) === entry &&
            currentAddress.current &&
            runtimeTaskKey(currentAddress.current) === runtimeTaskKey(address)
          )
            setLoading(false)
        })
      entry.pending = request
      return request
    },
    [currentAddress, entryFor, observeRead, onError, publish, stream]
  )

  // Gap and terminal notifications need a snapshot taken after the notification.
  // A read already in flight may describe the state before that event.
  const repairTranscript = useCallback(
    (address: RuntimeTaskAddress) => {
      const entry = entryFor(address)
      entry.repairRevision = (entry.repairRevision ?? 0) + 1
      if (entry.repair) return entry.repair
      const read = (async () => {
        if (entry.pending) await entry.pending.catch(() => null)
        let result: RuntimeTranscriptResponse | null = null
        let revision: number | undefined
        do {
          if (entries.current.get(runtimeTaskKey(address)) !== entry) return null
          revision = entry.repairRevision
          result = await reloadTranscript(address)
        } while (entry.repairRevision !== revision)
        return result
      })()
      const repair = read.finally(() => {
        if (entry.repair === repair) entry.repair = undefined
      })
      entry.repair = repair
      return repair
    },
    [entryFor, reloadTranscript]
  )

  const loadOlder = useCallback(
    async function readOlder(address: RuntimeTaskAddress): Promise<void> {
      const entry = entryFor(address)
      if (entry.older) return entry.older
      if (!entry.beforeCursor) return
      const beforeCursor = entry.beforeCursor
      const generation = entry.paginationGeneration
      const isCurrentPage = () =>
        entries.current.get(runtimeTaskKey(address)) === entry &&
        entry.paginationGeneration === generation
      const receive = observeRead?.(address, 'older')
      const request = stream
        .getTranscript(address, { beforeCursor })
        .then(transcript => {
          if (!isCurrentPage()) return
          receive?.(transcript)
          entry.conversation.prepend(transcript)
          entry.beforeCursor = transcript.beforeCursor ?? null
          entry.touchedAt = Date.now()
        })
        .catch(cause => {
          if (
            isCurrentPage() &&
            currentAddress.current &&
            runtimeTaskKey(currentAddress.current) === runtimeTaskKey(address)
          )
            onError(cause instanceof Error ? cause.message : String(cause), address, 'older', () =>
              readOlder(address)
            )
        })
        .finally(() => {
          if (!isCurrentPage() || entry.older !== request) return
          entry.older = undefined
          publish(address, entry)
        })
      entry.older = request
      publish(address, entry)
      return entry.older
    },
    [currentAddress, entryFor, observeRead, onError, publish, stream]
  )

  const loadMoreMessagesBefore = useCallback(async () => {
    const address = currentAddress.current
    if (address) await loadOlder(address)
  }, [currentAddress, loadOlder])

  const retainDevices = useCallback((deviceIds: string[]) => {
    const allowed = new Set(deviceIds)
    for (const key of entries.current.keys()) {
      const [deviceId] = JSON.parse(key) as [string, string]
      if (!allowed.has(deviceId)) entries.current.delete(key)
    }
  }, [])

  return {
    messages,
    loading,
    historyLoaded,
    hasMoreMessagesBefore,
    loadingMoreMessagesBefore,
    activate,
    reset,
    fail,
    rename,
    dispatchMessages,
    dispatchToAddress,
    readMessages,
    reloadTranscript,
    repairTranscript,
    loadMoreMessagesBefore,
    retainDevices,
  }
}

// Distinguish a missing live completion from a stale snapshot or item merge.
// Only compare opaque identities in memory; do not log them or any tool input/output.
function settledTurnToolCounts(
  snapshot: RuntimeConversationTurn[],
  hydrated: RuntimeConversationTurn[]
) {
  const historyByTurn = new Map(snapshot.map(turn => [turn.id, turn]))
  let runningInHistory = 0
  let finishedInHistory = 0
  let missingFromHistory = 0
  let missingTurnFromPage = 0
  for (const turn of hydrated) {
    if (turn.status === 'pending' || turn.status === 'streaming') continue
    const history = historyByTurn.get(turn.id)
    const historyItems = new Map(history?.items.map(item => [item.id, item]))
    for (const item of turn.items) {
      if (item.type !== 'block' || item.block.type !== 'tool') continue
      if (item.block.status === 'done' || item.block.status === 'error') continue
      if (!history) {
        missingTurnFromPage++
        continue
      }
      const stored = historyItems.get(item.id)
      if (stored?.type !== 'block' || stored.block.type !== 'tool') missingFromHistory++
      else if (stored.block.status === 'done' || stored.block.status === 'error') finishedInHistory++
      else runningInHistory++
    }
  }
  return { runningInHistory, finishedInHistory, missingFromHistory, missingTurnFromPage }
}
