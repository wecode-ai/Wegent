import type { getRuntimeConversationSnapshot } from '@/features/workbench/runtimeConversationCache'
import { latestConnectorAuthMessage } from '@/features/plugins/localConnectorAuthGate'
import type { RuntimeConversationItem, RuntimeConversationTurn } from '@/types/workbench'
import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'

type Conversation = ReturnType<typeof getRuntimeConversationSnapshot>

export interface PaneTranscript {
  getSnapshot: () => Conversation
  subscribe: (listener: () => void) => () => void
}

function equalExcept<T extends object>(before: T, after: T, ...omitted: (keyof T)[]) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof T)[])
  return [...keys].every(key => omitted.includes(key) || Object.is(before[key], after[key]))
}

function grows(before: string, after: string) {
  return after.length > before.length && after.startsWith(before)
}

function isReasoningUpdate(before: RuntimeConversationTurn, after: RuntimeConversationTurn) {
  if (!equalExcept(before, after, 'items', 'streamingThinkingContent')) return false
  return before.items.every((item, index) => {
    const next = after.items[index]
    return (
      item === next ||
      (item.type === 'block' &&
        next.type === 'block' &&
        item.block.type === 'thinking' &&
        next.block.type === 'thinking' &&
        item.block.status === 'streaming' &&
        equalExcept(item, next, 'block') &&
        equalExcept(item.block, next.block, 'content', 'contentOriginalChars', 'contentTruncated'))
    )
  })
}

/** Updates to an established reply's text or reasoning can leave the pane chrome untouched. */
export function isTranscriptOnlyStreamingUpdate(previous: Conversation, current: Conversation) {
  const before = previous.turns.at(-1)
  const after = current.turns.at(-1)
  if (
    !before ||
    !after ||
    before.status !== 'streaming' ||
    previous.turns.length !== current.turns.length ||
    previous.turns.some(
      (turn, index) => index < previous.turns.length - 1 && turn !== current.turns[index]
    ) ||
    before.items.length !== after.items.length
  ) {
    return false
  }
  if (isReasoningUpdate(before, after)) return true
  if (
    !equalExcept(before, after, 'items') ||
    before.items.some(
      (item, index) => index < before.items.length - 1 && item !== after.items[index]
    )
  ) {
    return false
  }

  const first = before.items.at(-1)
  const next = after.items.at(-1)
  // Authorization is derived from the tail message, including its live text.
  if (latestConnectorAuthMessage(previous.messages) || latestConnectorAuthMessage(current.messages))
    return false
  if (first?.type === 'assistant_text' && next?.type === 'assistant_text') {
    return (
      equalExcept(first, next, 'content', 'streamTextOffset') && grows(first.content, next.content)
    )
  }
  if (
    first?.type === 'block' &&
    next?.type === 'block' &&
    first.block.type === 'text' &&
    next.block.type === 'text'
  ) {
    return (
      equalExcept(first, next, 'block') &&
      equalExcept(first.block, next.block, 'content') &&
      grows(first.block.content, next.block.content)
    )
  }
  return false
}

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
