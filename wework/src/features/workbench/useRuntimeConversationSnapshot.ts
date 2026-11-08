import { useCallback, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  EMPTY_RUNTIME_CONVERSATION_SNAPSHOT,
  EMPTY_RUNTIME_CONVERSATION_METADATA,
  EMPTY_RUNTIME_QUEUED_MESSAGES,
  getRuntimeConversationMetadata,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuePaused,
  getRuntimeConversationSnapshot,
  subscribeRuntimeConversation,
} from './runtimeConversationCache'

function useRuntimeConversationValue<T>(
  address: RuntimeTaskAddress | null,
  read: (address: RuntimeTaskAddress) => T,
  empty: T
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      address ? subscribeRuntimeConversation(address, listener) : () => {},
    [address]
  )
  const getSnapshot = useCallback(() => (address ? read(address) : empty), [address, empty, read])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useRuntimeConversationMetadata(address: RuntimeTaskAddress | null) {
  return useRuntimeConversationValue(
    address,
    getRuntimeConversationMetadata,
    EMPTY_RUNTIME_CONVERSATION_METADATA
  )
}

export function useRuntimeConversationQueue(address: RuntimeTaskAddress | null) {
  const messages = useRuntimeConversationValue(
    address,
    getRuntimeConversationQueuedMessages,
    EMPTY_RUNTIME_QUEUED_MESSAGES
  )
  const paused = useRuntimeConversationValue(address, getRuntimeConversationQueuePaused, false)
  return { messages, paused }
}

/** A pane reads the shared conversation; it never owns another transcript copy. */
export function useRuntimeConversationSnapshot(address: RuntimeTaskAddress | null) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!address) return () => {}
      let cancel: (() => void) | undefined
      const unsubscribe = subscribeRuntimeConversation(address, (_action, coalesced) => {
        // A coalesced publication must not queue a second render frame.
        if (coalesced) {
          cancel?.()
          cancel = undefined
          listener()
          return
        }
        if (cancel) return
        const flush = () => {
          cancel = undefined
          listener()
        }
        if (typeof requestAnimationFrame === 'function') {
          const frame = requestAnimationFrame(flush)
          cancel = () => cancelAnimationFrame(frame)
        } else {
          const timer = setTimeout(flush, 16)
          cancel = () => clearTimeout(timer)
        }
      })
      return () => {
        cancel?.()
        unsubscribe()
      }
    },
    [address]
  )
  const getSnapshot = useCallback(
    () => (address ? getRuntimeConversationSnapshot(address) : EMPTY_RUNTIME_CONVERSATION_SNAPSHOT),
    [address]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
