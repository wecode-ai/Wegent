import { useCallback, useRef, useState, type RefObject } from 'react'

import { chatReducer, type ChatAction } from '@/domain/chatReducer'
import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import { hydrateRuntimeTranscript } from '@/domain/runtimeTranscriptHydration'
import { requestUserInputResponseKey } from '../../../packages/chat-core/src/runtime-user-input'
import type { RuntimeStream } from '@/services/runtimeStream'
import type { ChatMessage, RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/runtime'

// Match the PC conversation cache bounds; snapshots remain in memory only.
const MAX_CONVERSATIONS = 50
const IDLE_TTL_MS = 5 * 60 * 1000

interface ConversationSnapshot {
  messages: ChatMessage[]
  beforeCursor: string | null
  title?: string | null
  loaded: boolean
  touchedAt: number
  buffered: ChatAction[]
  paginationGeneration: number
  settledInputs: Map<string, ChatAction>
  hydrationMessages?: ChatMessage[]
  pending?: Promise<RuntimeTranscriptResponse | null>
  older?: Promise<void>
}

export function useMobileTranscript(
  stream: RuntimeStream,
  currentAddress: RefObject<RuntimeTaskAddress | null>,
  onError: (error: string) => void,
  observeRead?: (address: RuntimeTaskAddress) => (response: RuntimeTranscriptResponse) => void
) {
  const entries = useRef(new Map<string, ConversationSnapshot>())
  const messagesRef = useRef<ChatMessage[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMoreMessagesBefore, setHasMoreMessagesBefore] = useState(false)
  const [loadingMoreMessagesBefore, setLoadingMoreMessagesBefore] = useState(false)

  const entryFor = useCallback((address: RuntimeTaskAddress): ConversationSnapshot => {
    const key = runtimeTaskKey(address)
    let entry = entries.current.get(key)
    if (!entry) {
      entry = {
        messages: [],
        beforeCursor: null,
        loaded: false,
        touchedAt: Date.now(),
        buffered: [],
        paginationGeneration: 0,
        settledInputs: new Map(),
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
      if (options?.adoptDraft) entry.messages = messagesRef.current
      entries.current.delete(key)
      entries.current.set(key, entry)
      entry.touchedAt = Date.now()
      publish(address, entry)
      setLoading(!entry.loaded && entry.messages.length === 0)
      return entry.title
    },
    [entryFor, publish]
  )

  const reset = useCallback(() => {
    messagesRef.current = []
    setMessages([])
    setLoading(false)
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
      onError(error)
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
    entries.current.set(nextKey, {
      ...entry,
      buffered: [],
      hydrationMessages: undefined,
      pending: undefined,
      older: undefined,
    })
  }, [])

  const dispatchToAddress = useCallback(
    (address: RuntimeTaskAddress, action: ChatAction) => {
      const entry = entryFor(address)
      const key =
        action.type === 'user-input-response'
          ? requestUserInputResponseKey(action.response)
          : action.type === 'user-input-cancelled'
            ? action.key
            : null
      if (key) entry.settledInputs.set(key, action)
      if (entry.pending) entry.buffered.push(action)
      entry.messages = chatReducer(entry.messages, action)
      for (const settled of entry.settledInputs.values())
        entry.messages = chatReducer(entry.messages, settled)
      entry.touchedAt = Date.now()
      publish(address, entry)
    },
    [entryFor, publish]
  )

  const dispatchMessages = useCallback(
    (action: ChatAction) => {
      const address = currentAddress.current
      if (address) return dispatchToAddress(address, action)
      messagesRef.current = chatReducer(messagesRef.current, action)
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
      entry.buffered = []
      entry.hydrationMessages = entry.messages
      const receive = observeRead?.(address)
      const request = stream
        .getTranscript(address)
        .then(transcript => {
          if (entries.current.get(runtimeTaskKey(address)) !== entry) return null
          receive?.(transcript)
          const hydrated = hydrateRuntimeTranscript(
            entry.hydrationMessages ?? entry.messages,
            transcript,
            entry.buffered,
            entry.loaded
          )
          entry.messages = hydrated.messages
          for (const settled of entry.settledInputs.values())
            entry.messages = chatReducer(entry.messages, settled)
          if (!entry.loaded || hydrated.resetPagination) {
            entry.beforeCursor = transcript.beforeCursor ?? null
            entry.paginationGeneration += 1
            entry.older = undefined
          }
          entry.loaded = true
          entry.title = transcript.title
          entry.touchedAt = Date.now()
          publish(address, entry)
          return transcript
        })
        .catch(cause => {
          if (entries.current.get(runtimeTaskKey(address)) !== entry) return null
          throw cause
        })
        .finally(() => {
          entry.pending = undefined
          entry.buffered = []
          entry.hydrationMessages = undefined
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
    [currentAddress, entryFor, observeRead, publish, stream]
  )

  const loadMoreMessagesBefore = useCallback(async () => {
    const address = currentAddress.current
    if (!address) return
    const entry = entryFor(address)
    if (entry.older) return entry.older
    if (!entry.beforeCursor) return
    const beforeCursor = entry.beforeCursor
    const generation = entry.paginationGeneration
    const isCurrentPage = () =>
      entries.current.get(runtimeTaskKey(address)) === entry &&
      entry.paginationGeneration === generation
    const request = stream
      .getTranscript(address, { beforeCursor })
      .then(transcript => {
        if (!isCurrentPage()) return
        entry.messages = chatReducer(entry.messages, {
          type: 'prepend',
          messages: transcript.messages,
        })
        for (const settled of entry.settledInputs.values())
          entry.messages = chatReducer(entry.messages, settled)
        if (entry.hydrationMessages) {
          entry.hydrationMessages = chatReducer(entry.hydrationMessages, {
            type: 'prepend',
            messages: transcript.messages,
          })
        }
        entry.beforeCursor = transcript.beforeCursor ?? null
        entry.touchedAt = Date.now()
      })
      .catch(cause => {
        if (
          isCurrentPage() &&
          currentAddress.current &&
          runtimeTaskKey(currentAddress.current) === runtimeTaskKey(address)
        )
          onError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!isCurrentPage() || entry.older !== request) return
        entry.older = undefined
        publish(address, entry)
      })
    entry.older = request
    publish(address, entry)
    return entry.older
  }, [currentAddress, entryFor, onError, publish, stream])

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
    loadMoreMessagesBefore,
    retainDevices,
  }
}
