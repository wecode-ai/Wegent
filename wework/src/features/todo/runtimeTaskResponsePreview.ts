import type { RuntimeConversationTurn } from '@/types/workbench'

export function getRuntimeTaskResponsePreview(
  turns: RuntimeConversationTurn[],
  active: boolean
): string {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]
    if (!turn) continue
    const activeTurn = active && (turn.status === 'pending' || turn.status === 'streaming')
    if (activeTurn && turn.items.length === 0) return ''
    let segmentEnd = turn.items.length
    while (segmentEnd > 0) {
      const previousUserIndex = turn.items.findLastIndex(
        (item, itemIndex) => itemIndex < segmentEnd && item.type === 'user_message'
      )
      const segmentStart = previousUserIndex + 1
      const assistantLine = latestAssistantTextLine(turn.items, segmentStart, segmentEnd)
      if (activeTurn) return assistantLine
      const blockLine = active ? '' : latestTextBlockLine(turn.items, segmentStart, segmentEnd)
      if (assistantLine || blockLine) return assistantLine || blockLine
      segmentEnd = previousUserIndex
    }
  }
  return ''
}

function latestAssistantTextLine(
  items: RuntimeConversationTurn['items'],
  start: number,
  end: number
): string {
  for (let index = end - 1; index >= start; index -= 1) {
    const item = items[index]
    if (item?.type !== 'assistant_text') continue
    const line = latestNonEmptyLine(item.content)
    if (line) return line
  }
  return ''
}

function latestTextBlockLine(
  items: RuntimeConversationTurn['items'],
  start: number,
  end: number
): string {
  for (let index = end - 1; index >= start; index -= 1) {
    const item = items[index]
    if (item?.type !== 'block' || item.block.type !== 'text' || item.block.status !== 'done') {
      continue
    }
    const line = latestNonEmptyLine(item.block.content)
    if (line) return line
  }
  return ''
}

function latestNonEmptyLine(value: string): string {
  let end = value.length
  while (end > 0) {
    const start = value.lastIndexOf('\n', end - 1) + 1
    const line = value.slice(start, end).trim()
    if (line) return line
    if (start === 0) break
    end = start - 1
  }
  return ''
}
