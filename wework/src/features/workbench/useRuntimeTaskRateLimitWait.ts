import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { isRuntimeRateLimitWaitBlock } from '@wegent/chat-core/runtime-conversation-turns'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  getRuntimeConversationTurns,
  subscribeRuntimeConversation,
} from './runtimeConversationCache'

export function useRuntimeTaskRateLimitWait(address: RuntimeTaskAddress): boolean {
  const stableAddress = useMemo(
    () => ({ deviceId: address.deviceId, taskId: address.taskId }),
    [address.deviceId, address.taskId]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeRuntimeConversation(stableAddress, listener, { retainWhileSubscribed: false }),
    [stableAddress]
  )
  const getSnapshot = useCallback(
    () =>
      getRuntimeConversationTurns(stableAddress).some(
        turn =>
          (turn.status === 'streaming' || turn.status === 'pending') &&
          turn.items.some(item => item.type === 'block' && isRuntimeRateLimitWaitBlock(item.block))
      ),
    [stableAddress]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
