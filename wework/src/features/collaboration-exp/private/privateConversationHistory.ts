import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'
import type { RuntimeConversationTurn } from '@/types/workbench'

export interface PrivateHistorySource {
  turnId: string | null
  userMessageIds: readonly string[]
}

function hasUserMessage(turn: RuntimeConversationTurn, ids: ReadonlySet<string>): boolean {
  return (
    Boolean(turn.clientUserMessageId && ids.has(turn.clientUserMessageId)) ||
    turn.items.some(
      item => item.type === 'user_message' && (ids.has(item.id) || ids.has(item.message.id))
    )
  )
}

/** A historical source opens one proven turn and explicitly accepted continuations. */
export function selectPrivateHistory(
  turns: readonly RuntimeConversationTurn[],
  source: PrivateHistorySource,
  acceptedUserMessageIds: readonly string[] = []
) {
  const sourceIds = new Set(source.userMessageIds.filter(Boolean))
  const matches = turns.filter(turn =>
    source.turnId ? turn.id === source.turnId : hasUserMessage(turn, sourceIds)
  )
  if (matches.length !== 1) return { available: false, turns: [], messages: [] }
  const accepted = new Set(acceptedUserMessageIds)
  const selected = turns.filter(turn => turn === matches[0] || hasUserMessage(turn, accepted))
  return { available: true, turns: selected, messages: projectRuntimeConversationTurns(selected) }
}
