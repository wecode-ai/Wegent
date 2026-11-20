import { useMemo, useState, useSyncExternalStore } from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import type { ExecutorRuntimeClient } from '@/api/executorAccess'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import type { RuntimeConversationTurn } from '@/types/workbench'
import {
  getRuntimeConversationTurns,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'
import { BoardRuntimeConversations, type BoardTranscriptRead } from './boardRuntimeConversations'
import { boardRuntimeReadKey } from './boardRuntimeReadKey'

export interface BoardRuntimeConversation {
  address: RuntimeTaskAddress
  task?: RuntimeTaskSummary | null
}

export interface UseBoardRuntimeConversationsOptions {
  item: CloudLoopItem
  conversations: BoardRuntimeConversation[]
  enabled: boolean
  getRuntimeTranscript?: ExecutorRuntimeClient['getRuntimeTranscript']
  session?: BoardRuntimeConversations
  observedAddress?: RuntimeTaskAddress | null
  onTurns?: (turns: RuntimeConversationTurn[]) => void
}

const EMPTY_TURNS: RuntimeConversationTurn[] = []

export function useBoardRuntimeConversations({
  item,
  conversations,
  enabled,
  getRuntimeTranscript,
  session,
  observedAddress = conversations[0]?.address ?? null,
  onTurns,
}: UseBoardRuntimeConversationsOptions): RuntimeConversationTurn[] {
  const [localSession] = useState(() => session ?? new BoardRuntimeConversations())
  const owner = session ?? localSession
  const planKey = boardRuntimeReadKey(
    enabled && (item.status === 'in_review' || isLoopItemExecutionActive(item))
      ? conversations.map(({ address, task }) => ({
          address,
          includeFullContent: item.status === 'in_review' || task?.running === false,
          signature: boardRuntimeReadKey([
            item.status,
            item.execution_id,
            item.execution_state,
            item.execution_last_event_seq,
            task?.runtime,
            task?.threadId,
            task?.workspacePath,
            task?.updatedAt,
            task?.completedAt,
            task?.status,
            task?.turnStatus,
            task?.running,
            address,
          ]),
        }))
      : []
  )
  const addressKey = boardRuntimeReadKey(observedAddress)
  const source = useMemo(() => {
    const reads = JSON.parse(planKey) as BoardTranscriptRead[]
    const address = JSON.parse(addressKey) as RuntimeTaskAddress | null
    return {
      getSnapshot: () => (address ? getRuntimeConversationTurns(address) : EMPTY_TURNS),
      subscribe(listener: () => void) {
        if (!address) return () => undefined
        const notify = () => {
          onTurns?.(getRuntimeConversationTurns(address))
          listener()
        }
        const stop = subscribeRuntimeConversation(address, notify, { retainWhileSubscribed: false })
        onTurns?.(getRuntimeConversationTurns(address))
        const release = owner.observe(reads, getRuntimeTranscript)
        return () => {
          release()
          stop()
        }
      },
    }
  }, [addressKey, getRuntimeTranscript, onTurns, owner, planKey])
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}
