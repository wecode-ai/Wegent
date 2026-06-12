import { describe, expect, test } from 'vitest'
import {
  normalizeWorkbenchBlockStatus,
  reduceWorkbenchMessages,
  type WorkbenchMessage,
} from './index'

describe('reduceWorkbenchMessages', () => {
  test('adds user message and streams assistant chunks into one message', () => {
    const initial: WorkbenchMessage[] = []
    const withUser = reduceWorkbenchMessages(initial, {
      type: 'user_added',
      message: {
        id: 'local-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-05-25T00:00:00.000Z',
      },
    })
    const withStart = reduceWorkbenchMessages(withUser, {
      type: 'assistant_started',
      taskId: 1,
      subtaskId: 9,
      shellType: 'ClaudeCode',
    })
    const withChunk = reduceWorkbenchMessages(withStart, {
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

  test('finalizes thinking blocks when a tool block is created', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
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

    const withTool = reduceWorkbenchMessages(state, {
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

  test('preserves state for unknown runtime actions', () => {
    const state: WorkbenchMessage[] = [
      {
        id: 'assistant-9',
        role: 'assistant',
        content: 'hello',
        status: 'done',
        createdAt: '2026-05-25T00:00:00.000Z',
      },
    ]

    const next = reduceWorkbenchMessages(
      state,
      { type: 'unexpected' } as unknown as Parameters<typeof reduceWorkbenchMessages>[1]
    )

    expect(next).toBe(state)
  })
})

describe('normalizeWorkbenchBlockStatus', () => {
  test('keeps supported statuses and normalizes legacy or unknown statuses', () => {
    expect(normalizeWorkbenchBlockStatus('generating_arguments')).toBe('generating_arguments')
    expect(normalizeWorkbenchBlockStatus('pending')).toBe('pending')
    expect(normalizeWorkbenchBlockStatus('streaming')).toBe('streaming')
    expect(normalizeWorkbenchBlockStatus('done')).toBe('done')
    expect(normalizeWorkbenchBlockStatus('error')).toBe('error')
    expect(normalizeWorkbenchBlockStatus('running')).toBe('pending')
    expect(normalizeWorkbenchBlockStatus('unsupported')).toBe('pending')
    expect(normalizeWorkbenchBlockStatus()).toBe('pending')
  })
})
