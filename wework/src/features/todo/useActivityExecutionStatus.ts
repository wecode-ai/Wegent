import {
  activityExecutionDisplayStatus,
  isSingleActivityExecution,
  resolveActivityExecutionTurn,
} from '@wegent/chat-core/activity-execution-turn'
export { resolveActivityExecutionTurn } from '@wegent/chat-core/activity-execution-turn'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
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
  allowSingleTurn = false,
  onTurnIdentified?: (turnId: string) => void,
  onExecutionRead?: (turns: RuntimeConversationTurn[], turn: RuntimeConversationTurn | null) => void
) {
  const address = message?.runtimeAddress
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!address) return () => {}
      const identify = () => {
        const turns = getRuntimeConversationTurns(address)
        const turn = resolveActivityExecutionTurn(message, turns, turnId, allowSingleTurn)
        onExecutionRead?.(turns, turn ?? null)
        if (turn?.id) onTurnIdentified?.(turn.id)
      }
      const release = subscribeRuntimeConversation(address, () => {
        identify()
        listener()
      })
      identify()
      return release
    },
    [address, message, turnId, allowSingleTurn, onTurnIdentified, onExecutionRead]
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
  allowSingleTurn = false,
  onTurnIdentified?: (turnId: string) => void
) {
  const lifecycle = useRuntimeTaskLifecycle(message?.runtimeAddress)
  const reportExecutionRead = useCallback(
    (turns: RuntimeConversationTurn[], turn: RuntimeConversationTurn | null) => {
      const config = getDesktopE2ERuntimeConfig()
      if (!config.controlUrl || config.disabled || !message?.runtimeAddress) return
      logRuntimeTaskCreateStage('runtime-activity-execution', {
        messageId: message.messageId,
        recordedStatus: message.status,
        triggerMessageId: message.triggerMessageId,
        deviceId: message.runtimeAddress.deviceId,
        taskId: message.runtimeAddress.taskId,
        boundTurnId: turnId,
        recordedTurnId: message.metadata?.runtime_turn_id,
        resolvedTurn: turn ? { id: turn.id, status: turn.status } : null,
        cachedTurns: turns.slice(-4).map(item => ({
          id: item.id,
          status: item.status,
          clientUserMessageId: item.clientUserMessageId,
        })),
        execution: lifecycle?.execution,
        nativeTurn: lifecycle?.turn,
        busy: lifecycle?.derived.isBusy,
      })
    },
    [message, turnId, lifecycle]
  )
  const turn = useActivityExecutionStatus(
    message,
    turnId,
    allowSingleTurn,
    onTurnIdentified,
    reportExecutionRead
  )
  const turns = message?.runtimeAddress
    ? getRuntimeConversationTurns(message.runtimeAddress)
    : EMPTY_TURNS
  return {
    turn,
    status: activityExecutionDisplayStatus(
      message,
      turns,
      turn,
      Boolean(lifecycle?.execution.known && !lifecycle.derived.isBusy)
    ),
  }
}
