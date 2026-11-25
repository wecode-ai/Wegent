import { expect, test } from 'vitest'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { isAssistantTextAppend } from './workbenchPaneConversationPresentation'

test('only an append within an established streaming reply is transcript-only', () => {
  const text = {
    type: 'assistant_text' as const,
    id: 'text',
    content: 'First',
    createdAt: '2026-11-23T17:00:00Z',
    streamTextOffset: 5,
  }
  const turn: RuntimeConversationTurn = { id: 'turn', status: 'streaming', items: [text] }
  const previous = { turns: [turn], messages: [] }
  const next = { ...text, content: 'First next', streamTextOffset: 10 }
  const updated = { ...turn, items: [next] }

  expect(isAssistantTextAppend(previous, { ...previous, turns: [updated] })).toBe(true)
  for (const changed of [
    { ...updated, status: 'done' as const },
    { ...updated, items: [{ ...next, id: 'other' }] },
    { ...updated, items: [{ ...next, content: 'Replaced text' }] },
    { ...updated, items: [text, next] },
    { ...updated, contentTruncated: true },
  ]) {
    expect(isAssistantTextAppend(previous, { ...previous, turns: [changed] })).toBe(false)
  }
})
