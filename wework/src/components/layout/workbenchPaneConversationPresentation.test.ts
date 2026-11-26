import { expect, test } from 'vitest'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { isTranscriptOnlyStreamingUpdate } from './workbenchPaneConversationPresentation'

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

  expect(isTranscriptOnlyStreamingUpdate(previous, { ...previous, turns: [updated] })).toBe(true)
  for (const changed of [
    { ...updated, status: 'done' as const },
    { ...updated, items: [{ ...next, id: 'other' }] },
    { ...updated, items: [{ ...next, content: 'Replaced text' }] },
    { ...updated, items: [text, next] },
    { ...updated, contentTruncated: true },
  ]) {
    expect(isTranscriptOnlyStreamingUpdate(previous, { ...previous, turns: [changed] })).toBe(false)
  }
})

test('publishes reasoning within the transcript while keeping the pane snapshot stable', () => {
  const thinking = {
    type: 'block' as const,
    id: 'reasoning',
    block: {
      type: 'thinking' as const,
      id: 'reasoning',
      subtaskId: 'turn',
      status: 'streaming' as const,
      createdAt: 1,
      content: 'Checking',
    },
  }
  const command = {
    type: 'block' as const,
    id: 'command',
    block: {
      type: 'tool' as const,
      id: 'command',
      subtaskId: 'turn',
      toolName: 'bash',
      status: 'streaming' as const,
      createdAt: 2,
    },
  }
  const turn: RuntimeConversationTurn = {
    id: 'turn',
    status: 'streaming',
    items: [thinking, command],
    streamingThinkingContent: 'Checking',
  }
  const previous = { turns: [turn], messages: [] }
  const updated: RuntimeConversationTurn = {
    ...turn,
    streamingThinkingContent: 'Checking the tests',
    items: [{ ...thinking, block: { ...thinking.block, content: 'Checking the tests' } }, command],
  }
  expect(isTranscriptOnlyStreamingUpdate(previous, { ...previous, turns: [updated] })).toBe(true)
  const completedCommand = { ...command, block: { ...command.block, status: 'done' as const } }
  expect(
    isTranscriptOnlyStreamingUpdate(previous, {
      ...previous,
      turns: [{ ...updated, items: [updated.items[0], completedCommand] }],
    })
  ).toBe(false)
})
