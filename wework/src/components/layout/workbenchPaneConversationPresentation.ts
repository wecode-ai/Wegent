import type { getRuntimeConversationSnapshot } from '@/features/workbench/runtimeConversationCache'
import type { RuntimeConversationItem, RuntimeConversationTurn } from '@/types/workbench'
import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'

type Conversation = ReturnType<typeof getRuntimeConversationSnapshot>

function deferTurnText(
  turn: RuntimeConversationTurn,
  previous: RuntimeConversationTurn | undefined
): RuntimeConversationTurn {
  if (turn === previous || (turn.status !== 'pending' && turn.status !== 'streaming')) return turn

  const previousItems = new Map(previous?.items.map(item => [item.id, item]))
  const items = turn.items.map((item): RuntimeConversationItem => {
    const lastItem = previousItems.get(item.id)
    if (lastItem === item) return item
    if (item.type === 'assistant_text') {
      const content = lastItem?.type === 'assistant_text' ? lastItem.content : ''
      return content === item.content ? item : { ...item, content }
    }
    if (item.type !== 'block') return item

    const { block } = item
    if (
      (block.type !== 'text' && block.type !== 'thinking') ||
      block.status === 'done' ||
      block.status === 'error'
    )
      return item
    const content =
      lastItem?.type === 'block' && lastItem.block.type === block.type ? lastItem.block.content : ''
    return content === block.content ? item : { ...item, block: { ...block, content } }
  })
  const streamingThinkingContent = turn.streamingThinkingContent
    ? previous?.streamingThinkingContent
    : turn.streamingThinkingContent
  if (
    streamingThinkingContent === turn.streamingThinkingContent &&
    items.every((item, index) => item === turn.items[index])
  )
    return turn
  return { ...turn, items, streamingThinkingContent }
}

export function deferHiddenConversationText(current: Conversation, previous: Conversation) {
  const previousTurns = new Map(previous.turns.filter(turn => turn.id).map(turn => [turn.id, turn]))
  const turns = current.turns.map(turn => deferTurnText(turn, previousTurns.get(turn.id)))
  if (turns.every((turn, index) => turn === current.turns[index])) return current
  // Both turn and message consumers must see the same deferred text.
  return { turns, messages: projectRuntimeConversationTurns(turns) }
}
