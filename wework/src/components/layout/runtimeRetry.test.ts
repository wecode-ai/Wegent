import { expect, test, vi } from 'vitest'
import { retryRuntimeConversation } from '@wegent/collaboration/execution/retryRuntimeConversation'
import type { WorkbenchMessage } from '@/types/workbench'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'

test.each(['accepted', 'queued', 'rejected', 'thrown'] as const)(
  'keeps a pending question until the retry is delivered (%s)',
  async outcome => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'failed',
        role: 'assistant',
        status: 'failed',
        content: '',
        createdAt: '',
        blocks: [
          {
            id: 'question',
            type: 'tool',
            toolName: 'request_user_input_async',
            status: 'done',
            renderPayload: {
              kind: 'request_user_input',
              delivery: 'async',
              itemId: 'question',
              questions: [{ id: 'audience', question: 'Who receives this?' }],
            },
          },
        ],
      },
    ]
    const accept = vi.fn((message: WorkbenchMessage) => {
      messages.push(message)
    })
    let finish!: () => void
    const pending = retryRuntimeConversation({
      messageId: 'failed',
      messages,
      request: { address: { deviceId: 'device', taskId: 'task' } },
      labels: { continue: 'Continue', missing: 'Missing', failed: 'Rejected' },
      acceptUserMessage: accept,
      send: () =>
        new Promise((resolve, reject) => {
          finish = () =>
            outcome === 'thrown'
              ? reject(new Error('Transport failed'))
              : resolve({
                  accepted: outcome !== 'rejected',
                  queued: outcome === 'queued',
                  turnId: 'retry-turn',
                })
        }),
    })
    expect(accept).not.toHaveBeenCalled()
    expect(pendingRequestUserInputPayload(messages)?.itemId).toBe('question')
    const settled =
      outcome === 'rejected' || outcome === 'thrown'
        ? expect(pending).rejects.toThrow(outcome === 'thrown' ? 'Transport failed' : 'Rejected')
        : pending
    finish()
    await settled
    expect(accept).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0)
    expect(pendingRequestUserInputPayload(messages) === null).toBe(outcome === 'accepted')
  }
)
