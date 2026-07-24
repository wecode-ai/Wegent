import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { reconcileRuntimeConversationMessages } from './useWorkbenchPaneSession'

function message(overrides: Partial<WorkbenchMessage>): WorkbenchMessage {
  return {
    id: 'message',
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  }
}

describe('reconcileRuntimeConversationMessages', () => {
  test('uses a settled server transcript instead of stale streaming cache state', () => {
    const transcript = [message({ id: 'server', content: 'Complete response' })]
    const cached = [
      message({
        id: 'cached',
        content: 'Complete response with stale streaming metadata',
        status: 'streaming',
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, false)).toBe(transcript)
  })

  test('keeps richer live state while the server still reports the task running', () => {
    const transcript = [message({ id: 'server', content: 'Partial', status: 'streaming' })]
    const cached = [
      message({
        id: 'cached',
        content: 'Partial response from the live stream',
        status: 'streaming',
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, true)).toBe(cached)
  })
})
