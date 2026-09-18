import { describe, expect, it } from 'vitest'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { resolveActivityExecutionTurn } from './useActivityExecutionStatus'

const message = {
  messageId: 'run-1',
  triggerMessageId: 'request-1',
  sender: { type: 'agent' },
  metadata: {},
} as ProjectChatMessage
const turn = (
  id: string,
  status: RuntimeConversationTurn['status'],
  clientUserMessageId?: string
): RuntimeConversationTurn => ({ id, status, clientUserMessageId, items: [] })

describe('activity execution identity', () => {
  it.each(['done', 'failed', 'cancelled'] as const)(
    'keeps the original %s outcome when another turn runs',
    status => {
      const original = turn('turn-1', status, message.messageId)
      expect(
        resolveActivityExecutionTurn(message, [original, turn('turn-2', 'streaming', 'run-2')])
      ).toBe(original)
    }
  )
  it('matches an initial execution by the triggering comment id', () => {
    const original = turn('turn-1', 'done', message.triggerMessageId!)
    expect(resolveActivityExecutionTurn(message, [original])).toBe(original)
  })
  it('keeps a verified legacy turn binding when more turns arrive', () => {
    const original = turn('turn-1', 'done')
    expect(
      resolveActivityExecutionTurn(message, [original, turn('turn-2', 'failed')], 'turn-1')
    ).toBe(original)
  })
  it('does not guess from text, run id, order or an incomplete history', () => {
    expect(resolveActivityExecutionTurn(message, [turn('run-1', 'done')])).toBeUndefined()
    expect(
      resolveActivityExecutionTurn(
        message,
        [turn('turn-1', 'done'), turn('turn-2', 'done')],
        undefined,
        true
      )
    ).toBeUndefined()
    expect(
      resolveActivityExecutionTurn(message, [
        turn('turn-1', 'done', 'request-1'),
        turn('turn-2', 'done', 'request-1'),
      ])
    ).toBeUndefined()
  })
  it('does not apply the parent execution outcome to a subagent', () => {
    expect(
      resolveActivityExecutionTurn(
        { ...message, metadata: { kind: 'task_ai_subagent' } },
        [turn('turn-1', 'done')],
        undefined,
        true
      )
    ).toBeUndefined()
  })
})
