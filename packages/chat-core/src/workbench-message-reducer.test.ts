import { describe, expect, test } from 'vitest'
import {
  normalizeWorkbenchBlockStatus,
  reduceWorkbenchMessages,
  type WorkbenchMessage
} from './index'

describe('reduceWorkbenchMessages', () => {
  test('keeps only a preview window for very long assistant content', () => {
    const longPrefix = 'a'.repeat(200_010)
    const state = reduceWorkbenchMessages([], {
      type: 'assistant_chunk',
      subtaskId: 'long-text',
      content: `${longPrefix}tail`
    })

    expect(state[0].content.length).toBe(200_000)
    expect(state[0].content.endsWith('tail')).toBe(true)
    expect(state[0]).toMatchObject({
      contentTruncated: true,
      contentOriginalChars: 200_014,
      contentLoadRef: {
        messageId: 'assistant-long-text',
        subtaskId: 'long-text',
        kind: 'message_content'
      }
    })
  })

  test('does not restore full long assistant content on done', () => {
    const done = reduceWorkbenchMessages([], {
      type: 'assistant_done',
      subtaskId: 'done-long-text',
      content: `${'b'.repeat(200_010)}final`
    })

    expect(done[0].content.length).toBe(200_000)
    expect(done[0].content.endsWith('final')).toBe(true)
    expect(done[0].contentTruncated).toBe(true)
  })

  test('clears stale stream truncation metadata when done supplies short content', () => {
    const streamed = reduceWorkbenchMessages([], {
      type: 'assistant_chunk',
      subtaskId: 'short-final-content',
      content: 'partial response',
      offset: 20_000
    })
    const done = reduceWorkbenchMessages(streamed, {
      type: 'assistant_done',
      subtaskId: 'short-final-content',
      content: 'final response'
    })

    expect(done[0]).toMatchObject({
      content: 'final response',
      contentTruncated: undefined,
      contentOriginalChars: undefined,
      contentLoadRef: undefined
    })
  })

  test('keeps growing assistant original length after content is unloaded', () => {
    const truncated = reduceWorkbenchMessages([], {
      type: 'assistant_chunk',
      subtaskId: 'growing-long-text',
      content: `${'a'.repeat(200_010)}tail`,
      offset: 0
    })
    const next = reduceWorkbenchMessages(truncated, {
      type: 'assistant_chunk',
      subtaskId: 'growing-long-text',
      content: 'next',
      offset: 200_014
    })

    expect(next[0].content.length).toBe(200_000)
    expect(next[0].content.endsWith('tailnext')).toBe(true)
    expect(next[0].contentOriginalChars).toBe(200_018)
  })

  test('keeps only a preview window for very long tool output', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'block_created',
        subtaskId: '9',
        block: {
          id: 'call_1',
          subtaskId: '9',
          type: 'tool',
          toolName: 'bash',
          status: 'pending',
          createdAt: 1770000000000
        }
      }),
      {
        type: 'block_updated',
        subtaskId: '9',
        blockId: 'call_1',
        updates: {
          status: 'streaming',
          toolOutputDelta: `${'x'.repeat(120_010)}tail`
        }
      }
    )

    expect(state[0].blocks?.[0]).toMatchObject({
      id: 'call_1',
      type: 'tool',
      toolOutputTruncated: true,
      toolOutputOriginalChars: 120_014,
      toolOutputLoadRef: {
        subtaskId: '9',
        blockId: 'call_1',
        kind: 'tool_output'
      }
    })
    const output =
      state[0].blocks?.[0]?.type === 'tool' ? state[0].blocks[0].toolOutput : ''
    expect(typeof output).toBe('string')
    expect((output as string).length).toBe(120_000)
    expect((output as string).endsWith('tail')).toBe(true)
  })

  test('keeps growing tool output original length after output is unloaded', () => {
    const truncated = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'block_created',
        subtaskId: '9',
        block: {
          id: 'call_1',
          subtaskId: '9',
          type: 'tool',
          toolName: 'bash',
          status: 'pending',
          createdAt: 1770000000000
        }
      }),
      {
        type: 'block_updated',
        subtaskId: '9',
        blockId: 'call_1',
        updates: {
          status: 'streaming',
          toolOutputDelta: `${'x'.repeat(120_010)}tail`
        }
      }
    )

    const next = reduceWorkbenchMessages(truncated, {
      type: 'block_updated',
      subtaskId: '9',
      blockId: 'call_1',
      updates: {
        status: 'streaming',
        toolOutputDelta: 'next'
      }
    })

    const block = next[0].blocks?.[0]
    expect(block?.type).toBe('tool')
    if (block?.type !== 'tool') return
    expect(block.toolOutputOriginalChars).toBe(120_018)
    expect(String(block.toolOutput).length).toBe(120_000)
    expect(String(block.toolOutput).endsWith('tailnext')).toBe(true)
  })

  test('adds user message and streams assistant chunks into one message', () => {
    const initial: WorkbenchMessage[] = []
    const withUser = reduceWorkbenchMessages(initial, {
      type: 'user_added',
      message: {
        id: 'local-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-05-25T00:00:00.000Z'
      }
    })
    const withStart = reduceWorkbenchMessages(withUser, {
      type: 'assistant_started',
      taskId: '1',
      subtaskId: '9',
      shellType: 'ClaudeCode'
    })
    const withChunk = reduceWorkbenchMessages(withStart, {
      type: 'assistant_chunk',
      subtaskId: '9',
      content: 'hi'
    })

    expect(withChunk).toHaveLength(2)
    expect(withChunk[1]).toMatchObject({
      id: 'assistant-9',
      role: 'assistant',
      content: 'hi',
      status: 'streaming',
      shellType: 'ClaudeCode'
    })
  })

  test('uses chunk offsets to ignore duplicate assistant chunks', () => {
    const started = reduceWorkbenchMessages([], {
      type: 'assistant_started',
      subtaskId: '9'
    })
    const withHello = reduceWorkbenchMessages(started, {
      type: 'assistant_chunk',
      subtaskId: '9',
      content: '你好',
      offset: 0
    })
    const duplicated = reduceWorkbenchMessages(withHello, {
      type: 'assistant_chunk',
      subtaskId: '9',
      content: '你好',
      offset: 0
    })
    const completed = reduceWorkbenchMessages(duplicated, {
      type: 'assistant_chunk',
      subtaskId: '9',
      content: '，世界',
      offset: 2
    })

    expect(completed[0]).toMatchObject({
      role: 'assistant',
      content: '你好，世界',
      status: 'streaming'
    })
  })

  test('uses chunk offsets to append only uncovered overlap suffixes', () => {
    const started = reduceWorkbenchMessages([], {
      type: 'assistant_started',
      subtaskId: '10'
    })
    const withPrefix = reduceWorkbenchMessages(started, {
      type: 'assistant_chunk',
      subtaskId: '10',
      content: 'abcdef',
      offset: 0
    })
    const overlapped = reduceWorkbenchMessages(withPrefix, {
      type: 'assistant_chunk',
      subtaskId: '10',
      content: 'defghi',
      offset: 3
    })

    expect(overlapped[0]).toMatchObject({
      role: 'assistant',
      content: 'abcdefghi',
      status: 'streaming'
    })
  })

  test('tracks chunk offsets when a chunk creates the assistant message', () => {
    const withHello = reduceWorkbenchMessages([], {
      type: 'assistant_chunk',
      subtaskId: '11',
      content: 'hello',
      offset: 0
    })
    const duplicated = reduceWorkbenchMessages(withHello, {
      type: 'assistant_chunk',
      subtaskId: '11',
      content: 'hello',
      offset: 0
    })

    expect(duplicated[0]).toMatchObject({
      role: 'assistant',
      content: 'hello',
      status: 'streaming'
    })
  })

  test('late assistant stream creates an assistant message when a user message has the same subtask id', () => {
    const state: WorkbenchMessage[] = [
      {
        id: 'user-9',
        role: 'user',
        subtaskId: '9',
        content: 'hello',
        status: 'done',
        createdAt: '2026-05-25T00:00:00.000Z'
      }
    ]

    const withTool = reduceWorkbenchMessages(state, {
      type: 'block_created',
      subtaskId: '9',
      block: {
        id: 'call_1',
        subtaskId: '9',
        type: 'tool',
        toolName: 'bash',
        status: 'pending',
        createdAt: 1770000000000
      }
    })
    const withChunk = reduceWorkbenchMessages(withTool, {
      type: 'assistant_chunk',
      subtaskId: '9',
      content: 'Hi'
    })
    const done = reduceWorkbenchMessages(withChunk, {
      type: 'assistant_done',
      subtaskId: '9',
      content: 'Hi'
    })

    expect(done).toHaveLength(2)
    expect(done[0]).toMatchObject({
      role: 'user',
      content: 'hello',
      status: 'done'
    })
    expect(done[1]).toMatchObject({
      role: 'assistant',
      content: 'Hi',
      status: 'done',
      blocks: [{ type: 'tool', toolName: 'bash', status: 'done' }]
    })
  })

  test('ignores late chunks after an assistant message is done', () => {
    const streaming = reduceWorkbenchMessages([], {
      type: 'assistant_chunk',
      subtaskId: '9',
      content: 'Done.'
    })
    const done = reduceWorkbenchMessages(streaming, {
      type: 'assistant_done',
      subtaskId: '9',
      content: 'Done.'
    })
    const afterLateChunk = reduceWorkbenchMessages(done, {
      type: 'assistant_chunk',
      subtaskId: '9',
      content: 'Done.'
    })

    expect(afterLateChunk).toHaveLength(1)
    expect(afterLateChunk[0]).toMatchObject({
      role: 'assistant',
      subtaskId: '9',
      content: 'Done.',
      status: 'done'
    })
  })

  test('finalizes thinking blocks when a tool block is created', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'assistant_started',
        taskId: '1',
        subtaskId: '9'
      }),
      {
        type: 'assistant_chunk',
        subtaskId: '9',
        content: '',
        reasoningChunk: 'Running a command'
      }
    )

    const withTool = reduceWorkbenchMessages(state, {
      type: 'block_created',
      subtaskId: '9',
      block: {
        id: 'call_1',
        subtaskId: '9',
        type: 'tool',
        toolName: 'bash',
        toolInput: { command: 'pwd' },
        status: 'pending',
        createdAt: 1770000000000
      }
    })

    expect(withTool[0].blocks).toMatchObject([
      { type: 'thinking', status: 'done' },
      { type: 'tool', toolName: 'bash', status: 'pending' }
    ])
  })

  test('moves streamed content into a text block before a tool block', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'assistant_started',
        taskId: '1',
        subtaskId: '9'
      }),
      {
        type: 'assistant_chunk',
        subtaskId: '9',
        content: 'Let me inspect the repository first.'
      }
    )

    const withTool = reduceWorkbenchMessages(state, {
      type: 'block_created',
      subtaskId: '9',
      block: {
        id: 'call_1',
        subtaskId: '9',
        type: 'tool',
        toolName: 'bash',
        toolInput: { command: 'ls' },
        status: 'pending',
        createdAt: 1770000000000
      }
    })

    expect(withTool[0].content).toBe('')
    expect(withTool[0].blocks).toMatchObject([
      {
        type: 'text',
        content: 'Let me inspect the repository first.',
        status: 'done'
      },
      { type: 'tool', toolName: 'bash', status: 'pending' }
    ])
  })

  test('finalizes incoming processing blocks on done', () => {
    const state = reduceWorkbenchMessages([], {
      type: 'assistant_started',
      taskId: '1',
      subtaskId: '9'
    })

    const done = reduceWorkbenchMessages(state, {
      type: 'assistant_done',
      subtaskId: '9',
      content: 'Final',
      blocks: [
        {
          id: 'thinking-real',
          subtaskId: '9',
          type: 'thinking',
          content: 'Drafting',
          status: 'streaming',
          createdAt: 1770000000000
        },
        {
          id: 'call_1',
          subtaskId: '9',
          type: 'tool',
          toolName: 'bash',
          status: 'pending',
          createdAt: 1770000001000
        },
        {
          id: 'text-real',
          subtaskId: '9',
          type: 'text',
          content: 'Final text',
          status: 'streaming',
          createdAt: 1770000002000
        }
      ]
    })

    expect(done[0].blocks).toMatchObject([
      { id: 'thinking-real', type: 'thinking', status: 'done' },
      { id: 'call_1', type: 'tool', status: 'done' },
      { id: 'text-real', type: 'text', status: 'done' }
    ])
  })

  test('settles a streamed assistant message without replacing its content', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'assistant_started',
        taskId: '1',
        subtaskId: '9'
      }),
      {
        type: 'assistant_chunk',
        subtaskId: '9',
        content: 'streamed answer'
      }
    )

    const done = reduceWorkbenchMessages(state, {
      type: 'assistant_done',
      subtaskId: '9'
    })

    expect(done[0]).toMatchObject({
      content: 'streamed answer',
      status: 'done'
    })
  })

  test('marks all streaming assistant messages cancelled when no subtask is specified', () => {
    const state = [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'stop',
        status: 'done' as const,
        createdAt: '2026-05-25T00:00:00.000Z'
      },
      {
        id: 'assistant-old',
        role: 'assistant' as const,
        content: 'persisted streaming',
        status: 'streaming' as const,
        createdAt: '2026-05-25T00:00:00.000Z'
      },
      {
        id: 'assistant-new',
        role: 'assistant' as const,
        content: '',
        status: 'streaming' as const,
        subtaskId: '9',
        createdAt: '2026-05-25T00:00:01.000Z'
      }
    ]

    const cancelled = reduceWorkbenchMessages(state, {
      type: 'assistant_cancelled'
    })

    expect(cancelled[0]).toMatchObject({ role: 'user', status: 'done' })
    expect(cancelled[1]).toMatchObject({
      status: 'done',
      runtimeStatus: 'cancelled',
      stoppedNotice: true
    })
    expect(cancelled[2]).toMatchObject({
      status: 'done',
      runtimeStatus: 'cancelled',
      stoppedNotice: true
    })
  })

  test('clears stale stream error when an active block update arrives after disconnect', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'assistant_started',
        taskId: '1',
        subtaskId: '9'
      }),
      {
        type: 'assistant_error',
        subtaskId: '9',
        error: 'Device disconnected',
        errorType: 'container_error'
      }
    )

    const withTool = reduceWorkbenchMessages(state, {
      type: 'block_created',
      subtaskId: '9',
      block: {
        id: 'call_1',
        subtaskId: '9',
        type: 'tool',
        toolName: 'bash',
        status: 'pending',
        createdAt: 1770000000000
      }
    })
    const resumed = reduceWorkbenchMessages(withTool, {
      type: 'block_updated',
      subtaskId: '9',
      blockId: 'call_1',
      updates: {
        status: 'streaming',
        toolOutput: 'still running'
      }
    })

    expect(resumed[0].status).toBe('streaming')
    expect(resumed[0].error).toBeUndefined()
    expect(resumed[0].errorType).toBeUndefined()
    expect(resumed[0].blocks).toMatchObject([
      {
        id: 'call_1',
        type: 'tool',
        status: 'streaming',
        toolOutput: 'still running'
      }
    ])
  })

  test('appends tool output deltas without replacing existing output', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'block_created',
        subtaskId: '9',
        block: {
          id: 'call_1',
          subtaskId: '9',
          type: 'tool',
          toolName: 'bash',
          status: 'pending',
          createdAt: 1770000000000
        }
      }),
      {
        type: 'block_updated',
        subtaskId: '9',
        blockId: 'call_1',
        updates: {
          status: 'streaming',
          toolOutputDelta: 'hello'
        }
      }
    )

    const next = reduceWorkbenchMessages(state, {
      type: 'block_updated',
      subtaskId: '9',
      blockId: 'call_1',
      updates: {
        status: 'streaming',
        toolOutputDelta: ' world'
      }
    })

    expect(next[0].blocks).toMatchObject([
      {
        id: 'call_1',
        type: 'tool',
        status: 'streaming',
        toolOutput: 'hello world'
      }
    ])
  })

  test('preserves custom tool render payload on block create and update', () => {
    const requestPayload = {
      kind: 'request_user_input',
      request_id: 12,
      questions: [{ id: 'goal', question: 'What should I prioritize?' }]
    }
    const updatedPayload = {
      ...requestPayload,
      submitted: true
    }

    const state = reduceWorkbenchMessages([], {
      type: 'block_created',
      subtaskId: '9',
      block: {
        id: 'request-1',
        subtaskId: '9',
        type: 'tool',
        toolName: 'request_user_input',
        renderPayload: requestPayload,
        status: 'pending',
        createdAt: 1770000000000
      }
    })
    const updated = reduceWorkbenchMessages(state, {
      type: 'block_updated',
      subtaskId: '9',
      blockId: 'request-1',
      updates: {
        status: 'done',
        renderPayload: updatedPayload
      }
    })

    expect(state[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      toolName: 'request_user_input',
      renderPayload: requestPayload
    })
    expect(updated[0].blocks?.[0]).toMatchObject({
      type: 'tool',
      status: 'done',
      renderPayload: updatedPayload
    })
  })

  test('keeps a specific assistant error when a later generic task status error arrives', () => {
    const state = reduceWorkbenchMessages(
      reduceWorkbenchMessages([], {
        type: 'assistant_started',
        taskId: '1',
        subtaskId: '9'
      }),
      {
        type: 'assistant_error',
        subtaskId: '9',
        error: 'Codex CLI failed to resume thread: session not found',
        errorType: 'execution_error'
      }
    )

    const next = reduceWorkbenchMessages(state, {
      type: 'assistant_error',
      subtaskId: '9',
      error: 'Task failed with status: FAILED',
      errorType: 'execution_error'
    })

    expect(next[0]).toMatchObject({
      status: 'failed',
      error: 'Codex CLI failed to resume thread: session not found',
      errorType: 'execution_error'
    })
  })

  test('preserves state for unknown runtime actions', () => {
    const state: WorkbenchMessage[] = [
      {
        id: 'assistant-9',
        role: 'assistant',
        content: 'hello',
        status: 'done',
        createdAt: '2026-05-25T00:00:00.000Z'
      }
    ]

    const next = reduceWorkbenchMessages(state, {
      type: 'unexpected'
    } as unknown as Parameters<typeof reduceWorkbenchMessages>[1])

    expect(next).toBe(state)
  })
})

describe('normalizeWorkbenchBlockStatus', () => {
  test('keeps supported statuses and normalizes legacy or unknown statuses', () => {
    expect(normalizeWorkbenchBlockStatus('generating_arguments')).toBe(
      'generating_arguments'
    )
    expect(normalizeWorkbenchBlockStatus('pending')).toBe('pending')
    expect(normalizeWorkbenchBlockStatus('streaming')).toBe('streaming')
    expect(normalizeWorkbenchBlockStatus('done')).toBe('done')
    expect(normalizeWorkbenchBlockStatus('error')).toBe('error')
    expect(normalizeWorkbenchBlockStatus('completed')).toBe('done')
    expect(normalizeWorkbenchBlockStatus('succeeded')).toBe('done')
    expect(normalizeWorkbenchBlockStatus('failed')).toBe('error')
    expect(normalizeWorkbenchBlockStatus('running')).toBe('pending')
    expect(normalizeWorkbenchBlockStatus('inProgress')).toBe('pending')
    expect(normalizeWorkbenchBlockStatus('unsupported')).toBe('pending')
    expect(normalizeWorkbenchBlockStatus()).toBe('pending')
  })
})
