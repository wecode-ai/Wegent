import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatToolBlock, RequestUserInputPayload } from '@/types/runtime'
import { chatReducer } from './chatReducer'
import {
  pendingMobileUserInput,
  requestUserInputPayloadKey,
  userInputQuestions,
  userInputResponse,
} from './requestUserInput'

const payload: RequestUserInputPayload = {
  kind: 'request_user_input',
  requestId: 0,
  interactionScope: 'turn-a',
  questions: [
    {
      id: 'direction',
      question: 'Which way?',
      is_other: true,
      options: [{ label: 'First', value: 'first' }, { label: 'Second' }],
    },
  ],
}
const block: ChatToolBlock = {
  id: 'question',
  type: 'tool',
  toolName: 'request_user_input',
  subtaskId: 'turn-a',
  createdAt: 1,
  status: 'pending',
  renderPayload: payload,
}
const message: ChatMessage = {
  id: 'assistant',
  subtaskId: 'turn-a',
  role: 'assistant',
  content: '',
  createdAt: 1,
  status: 'streaming',
  blocks: [block],
}

describe('mobile request-user-input projection', () => {
  it('retains zero request IDs, scoped identity, option values, and free text', () => {
    expect(userInputQuestions(payload)[0]).toMatchObject({
      id: 'direction',
      allowCustom: true,
      options: [
        { label: 'First', value: 'first' },
        { label: 'Second', value: 'Second' },
      ],
    })
    const response = userInputResponse(payload, { direction: 'My own answer' })
    expect(response).toEqual({
      requestId: 0,
      itemId: undefined,
      interactionScope: 'turn-a',
      answers: { direction: { answers: ['My own answer'] } },
    })
    expect(pendingMobileUserInput([message]).has(requestUserInputPayloadKey(payload)!)).toBe(true)
  })

  it('does not let one turn answer a later request with a reused request ID', () => {
    const later = {
      ...message,
      id: 'later',
      blocks: [{ ...block, renderPayload: { ...payload, interactionScope: 'turn-b' } }],
    }
    const state = chatReducer([message, later], {
      type: 'user-input-response',
      response: userInputResponse(payload, { direction: 'first' }),
    })
    expect(
      pendingMobileUserInput(state).has(
        requestUserInputPayloadKey({ ...payload, interactionScope: 'turn-b' })!
      )
    ).toBe(true)
    expect((state[0]!.blocks![0] as ChatToolBlock).renderPayload).toHaveProperty('response')
    expect((state[1]!.blocks![0] as ChatToolBlock).renderPayload).not.toHaveProperty('response')
  })

  it.each(['answered', 'cancelled', 'expired'] as const)(
    'never offers an answer to %s requests',
    interactionStatus => {
      expect(
        pendingMobileUserInput([
          { ...message, blocks: [{ ...block, renderPayload: { ...payload, interactionStatus } }] },
        ]).size
      ).toBe(0)
    }
  )

  it('does not resolve an async question from an optimistic or rejected user send', () => {
    const asyncMessage = {
      ...message,
      blocks: [
        { ...block, status: 'done' as const, renderPayload: { ...payload, delivery: 'async' } },
      ],
    }
    const draft = chatReducer([asyncMessage], {
      type: 'optimistic-user',
      id: 'answer',
      content: 'Second',
      createdAt: 2,
    })
    expect(pendingMobileUserInput(draft).size).toBe(1)
    const delivered = chatReducer(draft, { type: 'user-delivered', id: 'answer' })
    expect(pendingMobileUserInput(delivered).size).toBe(0)
    expect((delivered[0]!.blocks![0] as ChatToolBlock).renderPayload).toHaveProperty(
      'response.answers.direction.answers',
      ['Second']
    )
  })

  it('preserves an accepted answer across a stale transcript refresh', () => {
    const response = userInputResponse(payload, { direction: 'first' })
    const accepted = chatReducer([message], { type: 'user-input-response', response })
    const refreshed = chatReducer(accepted, {
      type: 'merge-latest',
      messages: [
        {
          id: 'assistant',
          subtaskId: 'turn-a',
          role: 'assistant',
          content: '',
          blocks: [{ ...block }],
          status: 'running',
        },
      ],
    })
    expect(pendingMobileUserInput(refreshed).size).toBe(0)
    expect((refreshed[0]!.blocks![0] as ChatToolBlock).renderPayload).toHaveProperty(
      'response',
      response
    )
  })

  it('leaves historical and expired questions read-only', () => {
    expect(
      pendingMobileUserInput([
        message,
        { id: 'later-user', role: 'user', content: 'Continue', createdAt: 2, status: 'completed' },
      ]).size
    ).toBe(0)
    expect(
      pendingMobileUserInput([
        { ...message, blocks: [{ ...block, renderPayload: { ...payload, expiresAtUnixMs: 1 } }] },
      ]).size
    ).toBe(0)
  })

  it('submits plan feedback without also approving implementation', () => {
    const plan: RequestUserInputPayload = {
      ...payload,
      questions: [
        {
          id: 'implement',
          question: 'Implement this plan?',
          options: [{ label: 'Yes', value: 'yes' }],
        },
        { id: 'adjustment', question: 'What should change?', is_other: true },
      ],
    }
    const answers = { implement: 'yes', adjustment: 'Change the database first' }
    expect(userInputResponse(plan, answers, 'adjustment').answers).toEqual({
      adjustment: { answers: ['Change the database first'] },
    })
    expect(userInputResponse(plan, answers, 'implement').answers).toEqual({
      implement: { answers: ['yes'] },
    })
    expect(userInputResponse(plan, {}).answers).toEqual({ implement: { answers: ['yes'] } })
  })
})
