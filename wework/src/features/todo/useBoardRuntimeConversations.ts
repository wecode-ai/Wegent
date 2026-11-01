import { useEffect, useRef } from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import type { ExecutorRuntimeClient } from '@/api/executorAccess'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import {
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'
import {
  isRuntimePaneTranscriptConfirmedIdle,
  projectRuntimePaneTranscript,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'

export interface BoardRuntimeConversation {
  address: RuntimeTaskAddress
  task?: RuntimeTaskSummary | null
}

export interface UseBoardRuntimeConversationsOptions {
  item: CloudLoopItem
  conversations: BoardRuntimeConversation[]
  enabled: boolean
  getRuntimeTranscript?: ExecutorRuntimeClient['getRuntimeTranscript']
}

function conversationSignature(
  item: CloudLoopItem,
  { address, task }: BoardRuntimeConversation
): string {
  return JSON.stringify([
    item.status,
    item.execution_id ?? null,
    item.execution_state ?? null,
    item.execution_last_event_seq ?? null,
    task?.runtime ?? null,
    task?.threadId ?? null,
    task?.workspacePath ?? null,
    task?.updatedAt ?? null,
    task?.completedAt ?? null,
    task?.status ?? null,
    task?.turnStatus ?? null,
    address,
  ])
}

export function useBoardRuntimeConversations({
  item,
  conversations,
  enabled,
  getRuntimeTranscript,
}: UseBoardRuntimeConversationsOptions): void {
  const mounted = useRef(false)
  const attemptedSignatures = useRef(new Map<string, string>())
  const requestSequences = useRef(new Map<string, number>())
  const appliedSequences = useRef(new Map<string, number>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (
      !enabled ||
      !getRuntimeTranscript ||
      (item.status !== 'in_review' && !isLoopItemExecutionActive(item))
    ) {
      return
    }
    const requestedConversations = new Set<string>()
    for (const conversation of conversations) {
      const { address, task } = conversation
      const key = runtimeConversationKey(address)
      if (requestedConversations.has(key)) continue
      requestedConversations.add(key)
      const signature = conversationSignature(item, conversation)
      if (attemptedSignatures.current.get(key) === signature) continue
      attemptedSignatures.current.set(key, signature)
      const sequence = (requestSequences.current.get(key) ?? 0) + 1
      requestSequences.current.set(key, sequence)
      const turnsBeforeRead = getRuntimeConversationTurns(address)
      void getRuntimeTranscript({
        ...address,
        limit: 20,
        includeFullContent: item.status === 'in_review' || task?.running === false,
      })
        .then(response => {
          if (!mounted.current) return
          if (sequence < (appliedSequences.current.get(key) ?? 0)) return
          appliedSequences.current.set(key, sequence)
          const transcript = projectRuntimePaneTranscript(response)
          if (transcript.fullContent === true && isRuntimePaneTranscriptConfirmedIdle(transcript)) {
            // A board read must not retract progress published while it was pending.
            if (getRuntimeConversationTurns(address) !== turnsBeforeRead) return
            replaceRuntimeConversationSnapshot(address, transcript.turns)
          } else {
            reconcileRuntimeConversationSnapshot(address, transcript.turns)
          }
        })
        .catch(error => {
          if (!mounted.current) return
          console.warn('[Wework project board] failed to preload task conversation', {
            address,
            error,
          })
        })
    }
  }, [conversations, enabled, getRuntimeTranscript, item])
}
