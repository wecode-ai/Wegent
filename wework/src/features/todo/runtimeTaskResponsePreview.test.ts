// @vitest-environment node

import type { RuntimeConversationTurn } from '@/types/workbench'
import { describe, expect, test } from 'vitest'
import { getRuntimeTaskResponsePreview } from './runtimeTaskResponsePreview'

describe('runtimeTaskResponsePreview', () => {
  test('reads only the latest response line from canonical turns', () => {
    const turns: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        status: 'streaming',
        items: [
          {
            id: 'tool-1',
            type: 'block',
            block: {
              id: 'tool-1',
              subtaskId: 'turn-1',
              type: 'tool',
              toolName: 'functions.apply_patch',
              toolInput: { patch: 'x'.repeat(100_000) },
              status: 'done',
              createdAt: 1,
            },
          },
          {
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'older response line\nlatest response line',
            createdAt: '2026-09-11T00:00:00Z',
          },
        ],
      },
    ]

    expect(getRuntimeTaskResponsePreview(turns, true)).toBe('latest response line')
  })

  test('does not fall back while the newest active turn has no visible activity', () => {
    const turns: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'assistant-1',
            type: 'assistant_text',
            content: 'older response',
            createdAt: '2026-09-11T00:00:00Z',
          },
        ],
      },
      {
        id: 'turn-2',
        status: 'pending',
        items: [],
      },
    ]

    expect(getRuntimeTaskResponsePreview(turns, true)).toBe('')
  })

  test('uses the latest completed text block when there is no assistant text item', () => {
    const turns: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'text-1',
            type: 'block',
            block: {
              id: 'text-1',
              subtaskId: 'turn-1',
              type: 'text',
              content: 'completed response',
              status: 'done',
              createdAt: 1,
            },
          },
        ],
      },
    ]

    expect(getRuntimeTaskResponsePreview(turns, false)).toBe('completed response')
  })

  test('ignores unfinished text blocks when selecting a completed response', () => {
    const turns: RuntimeConversationTurn[] = [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'text-1',
            type: 'block',
            block: {
              id: 'text-1',
              subtaskId: 'turn-1',
              type: 'text',
              content: 'partial response',
              status: 'streaming',
              createdAt: 1,
            },
          },
        ],
      },
    ]

    expect(getRuntimeTaskResponsePreview(turns, false)).toBe('')
  })
})
