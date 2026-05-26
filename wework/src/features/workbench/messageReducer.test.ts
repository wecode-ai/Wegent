import { describe, expect, test } from 'vitest'
import { messageReducer } from './messageReducer'
import type { WorkbenchMessage } from '@/types/workbench'

describe('messageReducer', () => {
  test('adds user message and streams assistant chunks into one message', () => {
    const initial: WorkbenchMessage[] = []
    const withUser = messageReducer(initial, {
      type: 'user_added',
      message: {
        id: 'local-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-05-25T00:00:00.000Z',
      },
    })
    const withStart = messageReducer(withUser, {
      type: 'assistant_started',
      taskId: 1,
      subtaskId: 9,
    })
    const withChunk = messageReducer(withStart, {
      type: 'assistant_chunk',
      subtaskId: 9,
      content: 'hi',
    })

    expect(withChunk).toHaveLength(2)
    expect(withChunk[1]).toMatchObject({
      id: 'assistant-9',
      role: 'assistant',
      content: 'hi',
      status: 'streaming',
    })
  })

  test('marks assistant message failed on stream error', () => {
    const state = messageReducer([], {
      type: 'assistant_started',
      taskId: 1,
      subtaskId: 9,
    })

    const failed = messageReducer(state, {
      type: 'assistant_error',
      subtaskId: 9,
      error: 'network down',
    })

    expect(failed[0]).toMatchObject({
      status: 'failed',
      error: 'network down',
    })
  })
})
