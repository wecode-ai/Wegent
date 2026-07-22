import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { mergeRuntimeTranscriptMessages } from './runtimeTranscriptMessages'

function message(overrides: Partial<WorkbenchMessage>): WorkbenchMessage {
  return {
    id: 'message',
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('mergeRuntimeTranscriptMessages', () => {
  test('reconciles streamed and transcript assistant messages by subtask id', () => {
    const transcript = message({
      id: 'server-message',
      subtaskId: 'subtask-1',
      content: 'Created temporary.txt and ran ls -la.',
      runtimeMessageIndex: 1,
    })
    const streamed = message({
      id: 'assistant-subtask-1',
      subtaskId: 'subtask-1',
      content: 'Created temporary.txt and ran ls -la.',
      status: 'streaming',
    })

    const merged = mergeRuntimeTranscriptMessages([transcript], [streamed])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'server-message',
      subtaskId: 'subtask-1',
      status: 'done',
    })
  })

  test('keeps different assistant subtasks with identical content', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [message({ id: 'server-1', subtaskId: 'subtask-1', content: 'Same response' })],
      [message({ id: 'live-2', subtaskId: 'subtask-2', content: 'Same response' })]
    )

    expect(merged.map(item => item.id)).toEqual(['server-1', 'live-2'])
  })

  test('keeps distinct user messages with identical content', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [message({ id: 'user-1', role: 'user', content: 'Run ls' })],
      [message({ id: 'user-2', role: 'user', content: 'Run ls' })]
    )

    expect(merged.map(item => item.id)).toEqual(['user-1', 'user-2'])
  })

  test('reconciles live assistants to their transcript turn when subtask ids differ', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [
        message({ id: 'user-1', role: 'user', content: 'Write a file', runtimeMessageIndex: 0 }),
        message({
          id: 'server-assistant-1',
          subtaskId: 'turn-1',
          content: 'File written',
          runtimeMessageIndex: 1,
        }),
        message({ id: 'user-2', role: 'user', content: 'Edit a line', runtimeMessageIndex: 2 }),
        message({
          id: 'server-assistant-2',
          subtaskId: 'turn-2',
          content: 'File updated',
          runtimeMessageIndex: 3,
        }),
      ],
      [
        message({ id: 'user-1', role: 'user', content: 'Write a file' }),
        message({
          id: 'live-assistant-1',
          subtaskId: 'request-1',
          content: 'File written',
          blocks: [{ id: 'tool-1', type: 'tool', status: 'done', content: 'write' }],
        }),
        message({ id: 'user-2', role: 'user', content: 'Edit a line' }),
        message({
          id: 'live-assistant-2a',
          subtaskId: 'request-2a',
          content: 'File updated',
          blocks: [{ id: 'tool-2', type: 'tool', status: 'done', content: 'read' }],
        }),
        message({
          id: 'live-assistant-2b',
          subtaskId: 'request-2b',
          content: 'File updated',
          blocks: [{ id: 'tool-3', type: 'tool', status: 'done', content: 'edit' }],
        }),
      ]
    )

    expect(merged.map(item => item.id)).toEqual([
      'user-1',
      'server-assistant-1',
      'user-2',
      'server-assistant-2',
    ])
    expect(merged[1].blocks?.map(block => block.id)).toEqual(['tool-1'])
    expect(merged[3].blocks?.map(block => block.id)).toEqual(['tool-2', 'tool-3'])
  })

  test('keeps a new live turn that is not in the transcript yet', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [
        message({ id: 'user-1', role: 'user', content: 'First request', runtimeMessageIndex: 0 }),
        message({ id: 'assistant-1', content: 'First response', runtimeMessageIndex: 1 }),
      ],
      [
        message({ id: 'user-1', role: 'user', content: 'First request' }),
        message({ id: 'user-2', role: 'user', content: 'New request' }),
        message({ id: 'live-2', subtaskId: 'request-2', content: 'Working', status: 'streaming' }),
      ]
    )

    expect(merged.map(item => item.id)).toEqual(['user-1', 'assistant-1', 'user-2', 'live-2'])
  })
})
