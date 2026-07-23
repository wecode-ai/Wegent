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

  test('keeps a local user message between its persisted transcript neighbors', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [
        message({ id: 'older', runtimeMessageIndex: 0 }),
        message({ id: 'newer-assistant', runtimeMessageIndex: 3 }),
      ],
      [
        message({ id: 'user', role: 'user', runtimeMessageIndex: 1 }),
        message({ id: 'local-user', role: 'user', runtimeMessageIndex: undefined }),
        message({ id: 'newer-assistant', runtimeMessageIndex: 3 }),
      ]
    )

    expect(merged.map(item => item.id)).toEqual(['older', 'user', 'local-user', 'newer-assistant'])
  })

  test('appends messages after the last transcript anchor in their existing order', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [message({ id: 'persisted', runtimeMessageIndex: 0 })],
      [
        message({ id: 'persisted', runtimeMessageIndex: 0 }),
        message({ id: 'local-user', role: 'user', runtimeMessageIndex: undefined }),
        message({ id: 'streaming-assistant', runtimeMessageIndex: undefined }),
      ]
    )

    expect(merged.map(item => item.id)).toEqual(['persisted', 'local-user', 'streaming-assistant'])
  })

  test('sorts a transcript page loaded into a gap between existing pages', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [
        message({ id: 'middle-1', runtimeMessageIndex: 2 }),
        message({ id: 'middle-2', runtimeMessageIndex: 3 }),
      ],
      [
        message({ id: 'older', runtimeMessageIndex: 0 }),
        message({ id: 'newer', runtimeMessageIndex: 5 }),
      ]
    )

    expect(merged.map(item => item.id)).toEqual(['older', 'middle-1', 'middle-2', 'newer'])
  })

  test('preserves existing order when no messages have persisted indexes', () => {
    const merged = mergeRuntimeTranscriptMessages(
      [],
      [
        message({ id: 'user', role: 'user', runtimeMessageIndex: undefined }),
        message({ id: 'assistant', runtimeMessageIndex: undefined }),
      ]
    )

    expect(merged.map(item => item.id)).toEqual(['user', 'assistant'])
  })
})
