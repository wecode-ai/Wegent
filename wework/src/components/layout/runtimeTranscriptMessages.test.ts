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
})
