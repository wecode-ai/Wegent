import { describe, expect, test } from 'vitest'
import {
  applyRequestUserInputResponseToMessages,
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

  test('returns done request_user_input payloads without a response after refresh', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'done',
        blocks: [
          {
            id: 'request-1',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'done',
            renderPayload: { kind: 'request_user_input', request_id: 42 },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toEqual({
      kind: 'request_user_input',
      request_id: 42,
    })
  })

  test('ignores request_user_input payloads that already include a response', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        status: 'done',
        blocks: [
          {
            id: 'request-1',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'done',
            renderPayload: {
              kind: 'request_user_input',
              request_id: 42,
              response: {
                requestId: 42,
                answers: { goal: { answers: ['工作目标'] } },
              },
            },
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })

  test('does not create an implementation confirmation from assistant plan markdown', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: [
          '# 整理环境计划',
          '',
          '## Summary',
          '整理下载目录。',
          '',
          '## Test Plan',
          '确认结果。',
        ].join('\n'),
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })

  test('creates an implementation confirmation from an explicit assistant plan block', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            turnId: 1,
            type: 'plan',
            content: '# 整理环境计划\n\n- 整理下载目录。',
            status: 'done',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toEqual({
      kind: 'request_user_input',
      itemId: 'implementation-plan:assistant-plan:plan-1',
      questions: [
        {
          id: 'implement',
          question: '执行此计划?',
          options: [{ label: '是的，执行此计划' }],
        },
        {
          id: 'adjustment',
          question: '否，请告知 WeWork 如何调整',
          is_other: true,
        },
      ],
    })
  })

  test('does not create an implementation confirmation from a hidden assistant plan block', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            turnId: 1,
            type: 'plan',
            content: '# 整理环境计划',
            status: 'done',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
    ] as WorkbenchMessage[]

    expect(
      pendingRequestUserInputPayload(
        messages,
        new Set(['item:implementation-plan:assistant-plan:plan-1'])
      )
    ).toBeNull()
  })

  test('does not create an implementation confirmation after a later user message', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            turnId: 1,
            type: 'plan',
            content: '# 整理环境计划',
            status: 'done',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
      {
        id: 'user-after-plan',
        role: 'user',
        content: '是的，执行此计划',
        status: 'done',
        createdAt: '2026-06-30T00:00:02.000Z',
      },
    ] as WorkbenchMessage[]

    expect(pendingRequestUserInputPayload(messages)).toBeNull()
  })
})

describe('request user input message helpers', () => {
  test('normalizes request ids from payloads and responses', () => {
    expect(requestUserInputPayloadKey({ kind: 'request_user_input', request_id: 42 })).toBe(
      'request:42'
    )
    expect(requestUserInputResponseKey({ requestId: 42, answers: {} })).toBe('request:42')
  })

  test('stores the local answer on the matching assistant request block', () => {
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

    const nextMessages = applyRequestUserInputResponseToMessages([assistantMessage], {
      requestId: 42,
      answers: {
        direction: { answers: ['随便，我就想看看样式'] },
      },
    })

    expect(nextMessages).toHaveLength(1)
    expect(nextMessages[0].id).toBe('assistant-request')
    expect(nextMessages[0].blocks?.[0]).toMatchObject({
      status: 'done',
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        response: {
          requestId: 42,
          answers: {
            direction: { answers: ['随便，我就想看看样式'] },
          },
        },
      },
    })
  })

  test('stores the local answer on a done request block without a response', () => {
    const assistantMessage = {
      id: 'assistant-request',
      role: 'assistant',
      content: '',
      status: 'done',
      createdAt: '2026-06-30T00:00:01.000Z',
      blocks: [
        {
          id: 'request-1',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'done',
          renderPayload: { kind: 'request_user_input', request_id: 42 },
        },
      ],
    } as WorkbenchMessage

    const nextMessages = applyRequestUserInputResponseToMessages([assistantMessage], {
      requestId: 42,
      answers: {
        direction: { answers: ['继续'] },
      },
    })

    expect(nextMessages[0].blocks?.[0]).toMatchObject({
      status: 'done',
      renderPayload: {
        response: {
          requestId: 42,
          answers: {
            direction: { answers: ['继续'] },
          },
        },
      },
    })
  })

  test('keeps messages unchanged when no matching request exists', () => {
    const assistantMessage = {
      id: 'assistant',
      role: 'assistant',
      content: 'done',
      status: 'done',
      createdAt: '2026-06-30T00:00:01.000Z',
    } as WorkbenchMessage

    const nextMessages = applyRequestUserInputResponseToMessages([assistantMessage], {
      requestId: 42,
      answers: {},
    })

    expect(nextMessages).toEqual([assistantMessage])
  })
})
