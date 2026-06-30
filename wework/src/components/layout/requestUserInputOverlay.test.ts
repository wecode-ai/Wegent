import { describe, expect, test } from 'vitest'
import {
  insertUserMessageBeforeRequestUserInput,
  requestUserInputPayloadKey,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'

describe('pendingRequestUserInputPayload', () => {
  test('returns the latest pending request_user_input payload', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'completed',
        blocks: [
          {
            id: 'done',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'done',
            renderPayload: { kind: 'request_user_input', requestId: 1 },
          },
        ],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        status: 'streaming',
        blocks: [
          {
            id: 'pending',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            renderPayload: { kind: 'request_user_input', requestId: 2 },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toEqual({
      kind: 'request_user_input',
      requestId: 2,
    })
  })

  test('ignores non-request_user_input blocks', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'completed',
        blocks: [
          {
            id: 'command',
            type: 'tool',
            toolName: 'shell',
            status: 'pending',
            renderPayload: { kind: 'shell' },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })

  test('ignores request_user_input payloads that were already answered locally', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        blocks: [
          {
            id: 'pending',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            renderPayload: { kind: 'request_user_input', request_id: 42 },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages, new Set(['request:42']))).toBeNull()
  })
})

describe('request user input message helpers', () => {
  test('normalizes request ids from payloads and responses', () => {
    expect(requestUserInputPayloadKey({ kind: 'request_user_input', request_id: 42 })).toBe(
      'request:42'
    )
    expect(requestUserInputResponseKey({ requestId: 42, answers: {} })).toBe('request:42')
  })

  test('inserts the local user answer before the assistant request message', () => {
    const userMessage = {
      id: 'user-answer',
      role: 'user',
      content: '当前任务',
      status: 'done',
      createdAt: '2026-06-30T00:00:00.000Z',
    } as WorkbenchMessage
    const assistantMessage = {
      id: 'assistant-request',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '2026-06-30T00:00:01.000Z',
      blocks: [
        {
          id: 'request-1',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'pending',
          renderPayload: { kind: 'request_user_input', request_id: 42 },
        },
      ],
    } as WorkbenchMessage

    const nextMessages = insertUserMessageBeforeRequestUserInput([assistantMessage], userMessage, {
      requestId: 42,
      answers: {},
    })

    expect(nextMessages.map(message => message.id)).toEqual(['user-answer', 'assistant-request'])
  })

  test('appends the local user answer when no matching request exists', () => {
    const assistantMessage = {
      id: 'assistant',
      role: 'assistant',
      content: 'done',
      status: 'done',
      createdAt: '2026-06-30T00:00:01.000Z',
    } as WorkbenchMessage
    const userMessage = {
      id: 'user-answer',
      role: 'user',
      content: '继续',
      status: 'done',
      createdAt: '2026-06-30T00:00:02.000Z',
    } as WorkbenchMessage

    const nextMessages = insertUserMessageBeforeRequestUserInput([assistantMessage], userMessage, {
      requestId: 42,
      answers: {},
    })

    expect(nextMessages.map(message => message.id)).toEqual(['assistant', 'user-answer'])
  })
})
