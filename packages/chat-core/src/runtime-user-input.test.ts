// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from 'vitest'
import type { RequestUserInputPayload, RequestUserInputResponse } from './runtime'
import type { WorkbenchMessage } from './workbench-message-reducer'
import {
  findRequestUserInputPayload,
  applyRequestUserInputResponseToBlock,
  isAsyncRequestUserInputPayload,
  isPendingRequestUserInputBlock,
  isSettledRequestUserInputBlock,
  preserveRequestUserInputResponse,
  requestUserInputPayloadKey,
  requestUserInputResponseKey,
  resolveAsyncRequestUserInputAnswers,
  resolveAsyncRequestUserInputReplies,
  type RequestUserInputBlock,
} from './runtime-user-input'

const ASYNC_PAYLOAD: RequestUserInputPayload = {
  kind: 'request_user_input',
  delivery: 'async',
  itemId: 'call-question',
  questions: [
    {
      id: 'question_1',
      question: 'Which state jitters?',
      options: [{ label: 'Following' }, { label: 'Reading' }],
    },
  ],
}

function assistantMessage(payload: RequestUserInputPayload): WorkbenchMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-09-29T03:01:37.000Z',
    blocks: [
      {
        id: 'request-user-input-call-question',
        subtaskId: 'subtask-1',
        type: 'tool',
        toolName: 'request_user_input',
        status: 'pending',
        createdAt: 1,
        renderPayload: payload,
      },
    ],
  }
}

function userMessage(content: string): WorkbenchMessage {
  return {
    id: 'user-1',
    role: 'user',
    content,
    status: 'done',
    createdAt: '2026-09-29T03:05:00.000Z',
  }
}

describe('runtime input identity', () => {
  function form(scope: string): RequestUserInputBlock {
    return {
      id: 'request-user-input-0',
      subtaskId: scope,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'pending',
      renderPayload: {
        kind: 'request_user_input',
        requestId: 0,
        itemId: 'mcp_server_elicitation',
        interactionScope: scope,
        interactionStatus: 'pending',
        questions: [{ id: 'action', question: 'Publish?' }],
      },
    }
  }

  function answer(scope: string): RequestUserInputResponse {
    return {
      requestId: 0,
      itemId: 'mcp_server_elicitation',
      interactionScope: scope,
      answers: { action: { answers: ['Publish'] } },
    }
  }

  test('keeps a reused request ID visible after an earlier turn was dismissed', () => {
    const previous = form('previous-turn')
    const current = form('current-turn')
    const dismissed = new Set([requestUserInputPayloadKey(previous.renderPayload)!])

    expect(isPendingRequestUserInputBlock(previous, dismissed)).toBe(false)
    expect(isPendingRequestUserInputBlock(current, dismissed)).toBe(true)
    expect(requestUserInputPayloadKey(current.renderPayload)).toBe(
      requestUserInputResponseKey(answer('current-turn'))
    )
  })

  test('does not apply an old response or history answer to a new turn', () => {
    const previous = form('previous-turn')
    const current = form('current-turn')
    const answeredPrevious = applyRequestUserInputResponseToBlock(previous, answer('previous-turn'))

    expect(answeredPrevious).toMatchObject({
      status: 'done',
      renderPayload: { response: answer('previous-turn') },
    })
    expect(applyRequestUserInputResponseToBlock(current, answer('previous-turn'))).toBe(current)
    expect(preserveRequestUserInputResponse(answeredPrevious, current)).toBe(current)
    expect(
      findRequestUserInputPayload(
        [assistantMessage(previous.renderPayload), assistantMessage(current.renderPayload)],
        requestUserInputResponseKey(answer('current-turn'))
      )
    ).toBe(current.renderPayload)
  })

  test('does not match scoped forms using an unscoped or unidentified response', () => {
    const current = form('current-turn')

    expect(applyRequestUserInputResponseToBlock(current, { requestId: 0, answers: {} })).toBe(
      current
    )
    expect(applyRequestUserInputResponseToBlock(current, { answers: {} })).toBe(current)
    expect(requestUserInputPayloadKey({ requestId: 0 })).toBe('request:0')
  })

  test('scopes item identifiers when a request ID is absent', () => {
    const payload = { itemId: 'mcp_server_elicitation', interactionScope: 'previous-turn' }
    expect(requestUserInputPayloadKey(payload)).not.toBe(
      requestUserInputPayloadKey({ ...payload, interactionScope: 'current-turn' })
    )
  })

  test.each(['cancelled', 'expired'] as const)(
    'does not reopen a settled %s form or apply a late response',
    interactionStatus => {
      const current = form('current-turn')
      current.renderPayload.interactionStatus = interactionStatus

      expect(isPendingRequestUserInputBlock(current)).toBe(false)
      expect(applyRequestUserInputResponseToBlock(current, answer('current-turn'))).toBe(current)
    }
  )

  test('records the answer when the settled event arrives before the submit acknowledgment', () => {
    const current = form('current-turn')
    current.renderPayload.interactionStatus = 'answered'

    expect(isPendingRequestUserInputBlock(current)).toBe(false)
    expect(applyRequestUserInputResponseToBlock(current, answer('current-turn'))).toMatchObject({
      renderPayload: { interactionStatus: 'answered', response: answer('current-turn') },
    })
  })

  test('stops waiting at the deadline even when the runtime settlement event is missing', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const current = form('current-turn')
      current.renderPayload.expiresAtUnixMs = 2_000

      expect(isPendingRequestUserInputBlock(current)).toBe(true)
      vi.setSystemTime(2_000)
      expect(isPendingRequestUserInputBlock(current)).toBe(false)
      expect(isSettledRequestUserInputBlock(current)).toBe(true)
      expect(current.renderPayload).not.toHaveProperty('response')
      expect(current.renderPayload.interactionStatus).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not infer expiry from a missing or invalid deadline (%s)',
    expiresAtUnixMs => {
      const current = form('current-turn')
      current.renderPayload.expiresAtUnixMs = expiresAtUnixMs

      expect(isPendingRequestUserInputBlock(current)).toBe(true)
    }
  )
})

describe('async request user input', () => {
  test('treats only async delivery payloads as non-blocking', () => {
    expect(isAsyncRequestUserInputPayload(ASYNC_PAYLOAD)).toBe(true)
    expect(isAsyncRequestUserInputPayload({ kind: 'request_user_input' })).toBe(false)
    expect(isAsyncRequestUserInputPayload(null)).toBe(false)
  })

  test('derives the answer from the reply the user typed in the composer', () => {
    const messages = [assistantMessage(ASYNC_PAYLOAD), userMessage('Reading')]

    const resolved = resolveAsyncRequestUserInputAnswers(messages)
    const block = resolved[0].blocks?.[0]

    expect(resolved).not.toBe(messages)
    expect(block?.status).toBe('done')
    expect(block && 'renderPayload' in block && block.renderPayload).toMatchObject({
      response: { itemId: 'call-question', answers: { question_1: { answers: ['Reading'] } } },
    })
  })

  test('leaves an unanswered async question open', () => {
    const messages = [assistantMessage(ASYNC_PAYLOAD)]

    const resolved = resolveAsyncRequestUserInputAnswers(messages)

    expect(resolved).toBe(messages)
    expect(resolved[0].blocks?.[0].status).toBe('pending')
  })

  test('keeps a question that already carries its own answer', () => {
    const answered: RequestUserInputPayload = {
      ...ASYNC_PAYLOAD,
      response: { itemId: 'call-question', answers: { question_1: { answers: ['Following'] } } },
    }
    const messages = [assistantMessage(answered), userMessage('Reading')]

    const resolved = resolveAsyncRequestUserInputAnswers(messages)

    expect(resolved).toBe(messages)
  })

  test('does not resolve blocking questions from later user messages', () => {
    const blocking: RequestUserInputPayload = { kind: 'request_user_input', requestId: 42 }
    const messages = [assistantMessage(blocking), userMessage('Reading')]

    const resolved = resolveAsyncRequestUserInputAnswers(messages)

    expect(resolved).toBe(messages)
  })

  test('finds the payload behind a runtime answer key', () => {
    const messages = [assistantMessage(ASYNC_PAYLOAD)]

    expect(findRequestUserInputPayload(messages, 'item:call-question')).toBe(ASYNC_PAYLOAD)
    expect(findRequestUserInputPayload(messages, 'item:missing')).toBeNull()
    expect(findRequestUserInputPayload(messages, null)).toBeNull()
  })

  describe('replies attributed to the questions they answered', () => {
    test('shows the question above a single answer', () => {
      const messages = [assistantMessage(ASYNC_PAYLOAD), userMessage('Reading')]

      const replies = resolveAsyncRequestUserInputReplies(messages)

      expect(replies.get('user-1')).toEqual([
        { question: 'Which state jitters?', answer: 'Reading' },
      ])
    })

    test('pairs each line of a multi-question reply with its question', () => {
      const payload: RequestUserInputPayload = {
        ...ASYNC_PAYLOAD,
        questions: [
          { id: 'q1', question: '晴天还是雨天?' },
          { id: 'q2', question: '早上还是晚上?' },
          { id: 'q3', question: '猫还是狗?' },
        ],
      }
      const messages = [assistantMessage(payload), userMessage('晴天\n早上\n猫')]

      const replies = resolveAsyncRequestUserInputReplies(messages)

      expect(replies.get('user-1')).toEqual([
        { question: '晴天还是雨天?', answer: '晴天' },
        { question: '早上还是晚上?', answer: '早上' },
        { question: '猫还是狗?', answer: '猫' },
      ])
    })

    test('leaves a reply whose lines do not match the questions unattributed', () => {
      const payload: RequestUserInputPayload = {
        ...ASYNC_PAYLOAD,
        questions: [
          { id: 'q1', question: '晴天还是雨天?' },
          { id: 'q2', question: '早上还是晚上?' },
        ],
      }
      const messages = [assistantMessage(payload), userMessage('晴天')]

      expect(resolveAsyncRequestUserInputReplies(messages).size).toBe(0)
    })

    test('ignores unanswered and blocking questions', () => {
      const blocking: RequestUserInputPayload = { kind: 'request_user_input', requestId: 42 }

      expect(
        resolveAsyncRequestUserInputReplies([assistantMessage(ASYNC_PAYLOAD)]).size
      ).toBe(0)
      expect(
        resolveAsyncRequestUserInputReplies([
          assistantMessage(blocking),
          userMessage('Reading'),
        ]).size
      ).toBe(0)
    })
  })
})
