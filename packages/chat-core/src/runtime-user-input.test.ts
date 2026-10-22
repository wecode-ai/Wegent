// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'vitest'
import type { RequestUserInputPayload } from './runtime'
import type { WorkbenchMessage } from './workbench-message-reducer'
import {
  findRequestUserInputPayload,
  isAsyncRequestUserInputPayload,
  resolveAsyncRequestUserInputAnswers,
  resolveAsyncRequestUserInputReplies,
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
