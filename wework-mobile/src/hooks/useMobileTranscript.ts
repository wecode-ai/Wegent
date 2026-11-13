import { useCallback, useRef, useState, type RefObject } from 'react'

import { chatReducer, type ChatAction } from '@/domain/chatReducer'
import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import { hydrateRuntimeTranscript } from '@/domain/runtimeTranscriptHydration'
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

  const dispatchMessages = useCallback(
    (action: ChatAction) => {
      const address = currentAddress.current
      if (!address) {
        messagesRef.current = chatReducer(messagesRef.current, action)
        setMessages(messagesRef.current)
        return
      }
      const entry = entryFor(address)
      if (entry.pending) entry.buffered.push(action)
      entry.messages = chatReducer(entry.messages, action)
      entry.touchedAt = Date.now()
      publish(address, entry)
    },
    [currentAddress, entryFor, publish]
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
          if (!entry.loaded || hydrated.resetPagination)
            entry.beforeCursor = transcript.beforeCursor ?? null
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
    entry.older = stream
      .getTranscript(address, { beforeCursor })
      .then(transcript => {
        entry.messages = chatReducer(entry.messages, {
          type: 'prepend',
          messages: transcript.messages,
        })
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
          entries.current.get(runtimeTaskKey(address)) === entry &&
          currentAddress.current &&
          runtimeTaskKey(currentAddress.current) === runtimeTaskKey(address)
        )
          onError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        entry.older = undefined
        publish(address, entry)
      })
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
    dispatchMessages,
    reloadTranscript,
    loadMoreMessagesBefore,
    retainDevices,
  }
}
