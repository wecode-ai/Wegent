import type { ProjectChatMessage } from './project-chat'
import type { RuntimeConversationTurn } from './runtime-conversation'

export function isSingleActivityExecution(
  messages: ProjectChatMessage[],
  message: ProjectChatMessage | undefined
) {
  return (
    Boolean(message?.runtimeAddress) &&
    messages.filter(
      candidate =>
        candidate.sender.type === 'agent' &&
        candidate.metadata.kind !== 'task_ai_subagent' &&
        candidate.runtimeAddress?.deviceId === message?.runtimeAddress?.deviceId &&
        candidate.runtimeAddress?.taskId === message?.runtimeAddress?.taskId
    ).length === 1
  )
}

/** Associate a run with facts from its own turn, never the latest task outcome. */
export function resolveActivityExecutionTurn(
  message: ProjectChatMessage | undefined,
  turns: RuntimeConversationTurn[],
  turnId?: string,
  allowSingleTurn = false
): RuntimeConversationTurn | undefined {
  if (!message || message.sender.type !== 'agent' || message.metadata.kind === 'task_ai_subagent') {
    return undefined
  }
  if (turnId) return turns.find(turn => turn.id === turnId)
  const matchingTurns = (messageId: string) =>
    turns.filter(turn => {
      const ids = [
        turn.clientUserMessageId,
        ...turn.items.flatMap(item => (item.type === 'user_message' ? [item.id] : [])),
      ]
      return ids.includes(messageId)
    })
  const directMatches = matchingTurns(message.messageId)
  if (directMatches.length) return directMatches.length === 1 ? directMatches[0] : undefined
  const matches = message.triggerMessageId ? matchingTurns(message.triggerMessageId) : []
  if (matches.length === 1) return matches[0]
  // Legacy runs require a complete, single-run, single-turn conversation.
  if (matches.length === 0 && allowSingleTurn && turns.length === 1 && turns[0].id) {
    return turns[0]
  }
  return undefined
}

/** An idle task cannot establish success for an unidentifiable execution. */
export function activityExecutionDisplayStatus(
  message: ProjectChatMessage | undefined,
  turns: RuntimeConversationTurn[],
  turn: RuntimeConversationTurn | undefined,
  idle: boolean
) {
  const recordedStatus = message?.status.toLowerCase()
  return (
    turn?.status ??
    (recordedStatus &&
    ['completed', 'failed', 'cancelled', 'canceled'].includes(recordedStatus)
      ? recordedStatus
      : undefined) ??
    (message?.runtimeAddress &&
    message.metadata.kind !== 'task_ai_subagent' &&
    !turns.length &&
    idle
      ? 'unknown'
      : undefined)
  )
}
