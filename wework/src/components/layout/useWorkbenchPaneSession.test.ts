import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  reconcileRuntimeConversationMessages,
  transcriptSettlesLatestSeededTurn,
} from './useWorkbenchPaneSession'

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

describe('transcriptSettlesLatestSeededTurn', () => {
  test('does not settle a live turn from an older turn with duplicate user content', () => {
    const transcript = [
      message({ id: 'older-user', role: 'user', content: 'Continue' }),
      message({ id: 'older-assistant', content: 'Older completed response' }),
    ]
    const seeded = [message({ id: 'live-user', role: 'user', content: 'Continue' })]

    expect(transcriptSettlesLatestSeededTurn(transcript, seeded)).toBe(false)
  })

  test('settles the seeded turn only after its client message id appears', () => {
    const seeded = [message({ id: 'live-user', role: 'user', content: 'Continue' })]
    const transcript = [
      message({ id: 'live-user', role: 'user', content: 'Continue' }),
      message({ id: 'live-assistant', content: 'Current completed response' }),
    ]

    expect(transcriptSettlesLatestSeededTurn(transcript, seeded)).toBe(true)
  })
})
