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

  test('keeps unsettled cached state while the server still reports the task running', () => {
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

  test('keeps a completed cached plan when the transcript only settles an older turn', () => {
    const olderUser = message({
      id: 'older-user',
      role: 'user',
      content: 'Earlier request',
      turnId: 'turn-1',
    })
    const olderAssistant = message({
      id: 'older-assistant',
      content: 'Earlier response',
      turnId: 'turn-1',
    })
    const transcript = [olderUser, olderAssistant]
    const cached = [
      olderUser,
      olderAssistant,
      message({ id: 'latest-user', role: 'user', content: 'Create a plan' }),
      message({
        id: 'latest-assistant',
        turnId: 'turn-2',
        blocks: [
          {
            id: 'plan-1',
            subtaskId: 1,
            type: 'plan',
            content: '# Background plan\n- Keep the generated plan visible',
            status: 'done',
            createdAt: Date.parse('2026-07-24T00:00:00.000Z'),
          },
        ],
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, false)).toBe(cached)
  })

  test('uses a richer transcript when optimistic and server user IDs do not match', () => {
    const cached = [message({ id: 'optimistic-user', role: 'user', content: 'Create a plan' })]
    const transcript = [
      message({
        id: 'server-user',
        role: 'user',
        content: 'Create a plan',
        turnId: 'turn-1',
      }),
      message({
        id: 'server-assistant',
        turnId: 'turn-1',
        blocks: [
          {
            id: 'plan-1',
            subtaskId: 1,
            type: 'plan',
            content: '# Background plan\n- Keep the generated plan visible',
            status: 'done',
            createdAt: Date.parse('2026-07-24T00:00:00.000Z'),
          },
        ],
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, false)).toBe(transcript)
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

  test('uses the completed turn id when the cached response has one', () => {
    const seeded = [
      message({ id: 'live-user', role: 'user', content: 'Create a plan' }),
      message({ id: 'live-assistant', turnId: 'turn-2', content: 'Cached plan' }),
    ]
    const staleTranscript = [
      message({ id: 'older-user', role: 'user', turnId: 'turn-1', content: 'Earlier request' }),
      message({ id: 'older-assistant', turnId: 'turn-1', content: 'Earlier response' }),
    ]
    const currentTranscript = [
      message({ id: 'server-user', role: 'user', turnId: 'turn-2', content: 'Create a plan' }),
      message({ id: 'server-assistant', turnId: 'turn-2', content: 'Server plan' }),
    ]

    expect(transcriptSettlesLatestSeededTurn(staleTranscript, seeded)).toBe(false)
    expect(transcriptSettlesLatestSeededTurn(currentTranscript, seeded)).toBe(true)
  })
})
