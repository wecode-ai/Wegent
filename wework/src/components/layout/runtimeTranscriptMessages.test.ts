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
  test('merges historical transcript pages by stable message id', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [message({ id: 'older', content: 'Older', runtimeMessageIndex: 0 })],
      [
        message({ id: 'older', content: 'Older', runtimeMessageIndex: 0 }),
        message({ id: 'newer', content: 'Newer', runtimeMessageIndex: 1 }),
      ]
    )

    expect(merged.map(item => item.id)).toEqual(['older', 'newer'])
  })

  test('keeps distinct messages instead of guessing identity from content or subtask', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [message({ id: 'server', subtaskId: 'turn-1', content: 'Same response' })],
      [message({ id: 'live', subtaskId: 'request-1', content: 'Same response' })]
    )

    expect(merged.map(item => item.id)).toEqual(['server', 'live'])
  })
})
