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
    (listener: () => void) => {
      if (!address) return () => {}
      let cancel: (() => void) | undefined
      const unsubscribe = subscribeRuntimeConversation(address, () => {
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
