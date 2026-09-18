import {
  activityExecutionDisplayStatus,
  isSingleActivityExecution,
  resolveActivityExecutionTurn,
} from '@wegent/chat-core/activity-execution-turn'
export { resolveActivityExecutionTurn } from '@wegent/chat-core/activity-execution-turn'
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { useRuntimeTaskLifecycle } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeConversationTurn } from '@/types/workbench'
import {
  getRuntimeConversationTurns,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'

const EMPTY_TURNS: RuntimeConversationTurn[] = []

/** Read execution facts without changing the comment's business state. */
export function useActivityExecutionStatus(
  message: ProjectChatMessage | undefined,
  turnId?: string,
  allowSingleTurn = false
) {
  const address = message?.runtimeAddress
  const subscribe = useCallback(
    (listener: () => void) =>
      address ? subscribeRuntimeConversation(address, listener) : () => {},
    [address]
  )
  const getSnapshot = useCallback(
    () => (address ? getRuntimeConversationTurns(address) : EMPTY_TURNS),
    [address]
  )
  const turns = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return resolveActivityExecutionTurn(message, turns, turnId, allowSingleTurn)
}

function executionKey(message: ProjectChatMessage) {
  return JSON.stringify([
    message.runtimeAddress?.deviceId,
    message.runtimeAddress?.taskId,
    message.messageId,
  ])
}

/** Remember only verified turn identity; statuses stay in the conversation cache. */
export function useActivityExecutionBinding(messages: ProjectChatMessage[], messageId?: string) {
  const [turnIds, setTurnIds] = useState<Record<string, string>>({})
  const activityMessage = messages.find(message => message.messageId === messageId)
  const getTurnId = (message: ProjectChatMessage) => turnIds[executionKey(message)]
  const onExecutionTurnIdentified = useCallback(
    (turnId: string) => {
      if (!activityMessage) return
      const key = executionKey(activityMessage)
      setTurnIds(current => (current[key] === turnId ? current : { ...current, [key]: turnId }))
    },
    [activityMessage]
  )
  return {
    getTurnId,
    overlay: {
      activityMessage,
      executionTurnId: activityMessage ? getTurnId(activityMessage) : undefined,
      singleExecution: isSingleActivityExecution(messages, activityMessage),
      onExecutionTurnIdentified,
    },
  }
}

/** Liveness may rule out running; it cannot prove an unmatched run succeeded. */
export function useActivityExecutionDisplayStatus(
  message: ProjectChatMessage | undefined,
  turnId?: string,
  allowSingleTurn = false
) {
  const turn = useActivityExecutionStatus(message, turnId, allowSingleTurn)
  const lifecycle = useRuntimeTaskLifecycle(message?.runtimeAddress)
  return {
    turn,
    status: activityExecutionDisplayStatus(
      message,
      message?.runtimeAddress ? getRuntimeConversationTurns(message.runtimeAddress) : EMPTY_TURNS,
      turn,
      Boolean(lifecycle?.execution.known && !lifecycle.derived.isBusy)
    ),
  }
}
