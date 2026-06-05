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
      shellType: 'ClaudeCode',
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
      shellType: 'ClaudeCode',
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

  test('streams reasoning chunks into a thinking block', () => {
    const state = messageReducer([], {
      type: 'assistant_started',
      taskId: 1,
      subtaskId: 9,
    })

    const withThinking = messageReducer(state, {
      type: 'assistant_chunk',
      subtaskId: 9,
      content: '',
      reasoningChunk: 'Reading files',
    })
    const updated = messageReducer(withThinking, {
      type: 'assistant_chunk',
      subtaskId: 9,
      content: '',
      reasoningChunk: ' and checking tests',
    })

    expect(updated[0].content).toBe('')
    expect(updated[0].blocks).toMatchObject([
      {
        type: 'thinking',
        content: 'Reading files and checking tests',
        status: 'streaming',
      },
    ])
  })

  test('finalizes thinking blocks when a tool block is created', () => {
    const state = messageReducer(
      messageReducer([], {
        type: 'assistant_started',
        taskId: 1,
        subtaskId: 9,
      }),
      {
        type: 'assistant_chunk',
        subtaskId: 9,
        content: '',
        reasoningChunk: 'Running a command',
      }
    )

    const withTool = messageReducer(state, {
      type: 'block_created',
      subtaskId: 9,
      block: {
        id: 'call_1',
        subtaskId: 9,
        type: 'tool',
        toolName: 'bash',
        toolInput: { command: 'pwd' },
        status: 'pending',
        createdAt: 1770000000000,
      },
    })

    expect(withTool[0].blocks).toMatchObject([
      { type: 'thinking', status: 'done' },
      { type: 'tool', toolName: 'bash', status: 'pending' },
    ])
  })

  test('replaces temporary processing blocks with persisted blocks on done', () => {
    const state = messageReducer(
      messageReducer([], {
        type: 'assistant_started',
        taskId: 1,
        subtaskId: 9,
      }),
      {
        type: 'assistant_chunk',
        subtaskId: 9,
        content: '',
        reasoningChunk: 'Drafting',
      }
    )

    const done = messageReducer(state, {
      type: 'assistant_done',
      subtaskId: 9,
      content: 'Final',
      blocks: [
        {
          id: 'thinking-real',
          subtaskId: 9,
          type: 'thinking',
          content: 'Drafting',
          status: 'done',
          createdAt: 1770000000000,
        },
      ],
    })

    expect(done[0]).toMatchObject({
      content: 'Final',
      status: 'done',
      blocks: [{ id: 'thinking-real', type: 'thinking', status: 'done' }],
    })
  })
})
