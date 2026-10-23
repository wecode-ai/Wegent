import { useCallback, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  EMPTY_RUNTIME_CONVERSATION_SNAPSHOT,
  getRuntimeConversationSnapshot,
  subscribeRuntimeConversation,
} from './runtimeConversationCache'

/** A pane reads the shared conversation; it never owns another transcript copy. */
export function useRuntimeConversationSnapshot(address: RuntimeTaskAddress | null) {
  const subscribe = useCallback(
    (listener: () => void) =>
      address ? subscribeRuntimeConversation(address, listener) : () => {},
    [address]
  )
  const getSnapshot = useCallback(
    () => (address ? getRuntimeConversationSnapshot(address) : EMPTY_RUNTIME_CONVERSATION_SNAPSHOT),
    [address]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
