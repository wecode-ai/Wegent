// @vitest-environment node

import { isImplementationPlanConfirmationResponse } from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'
import { describe, expect, test } from 'vitest'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'

describe('pendingRequestUserInputPayload', () => {
  test.each(['pending', 'streaming', 'failed'] as const)(
    'retains a question across an undelivered %s message',
    status => {
      const payload = {
        kind: 'request_user_input' as const,
        delivery: 'async',
        itemId: 'pending-guidance',
        questions: [{ id: 'detail', question: 'Which rule?' }],
      }
      const question: WorkbenchMessage = {
        id: 'question',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: '',
        blocks: [
          {
            id: 'question',
            type: 'tool',
            status: 'done',
            toolName: 'request_user_input_async',
            renderPayload: payload,
          },
        ],
      }
      const reply: WorkbenchMessage = {
        id: 'guidance',
        role: 'user',
        content: 'Keep the original rule',
        status,
        runtimeGuidance: true,
        createdAt: '',
      }
      expect(pendingRequestUserInputPayload([question, reply])).toEqual(payload)
      expect(pendingRequestUserInputPayload([question, { ...reply, status: 'done' }])).toBeNull()
    }
  )
  test('detects only explicit implementation plan confirmation responses', () => {
    expect(
      isImplementationPlanConfirmationResponse({
        answers: {
          implement: { answers: ['是的，执行此计划'] },
        },
      })
    ).toBe(true)

    expect(
      isImplementationPlanConfirmationResponse({
        answers: {
          adjustment: { answers: ['先缩小范围'] },
        },
      })
    ).toBe(false)

    expect(isImplementationPlanConfirmationResponse({ answers: {} })).toBe(false)
  })

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

  test('exposes a URL authorization with empty questions and request ID zero', () => {
    const payload = {
      kind: 'request_user_input',
      requestId: 0,
      interactionKind: 'mcp_url',
      url: 'https://chatgpt.com/connect/github',
      questions: [],
    }
    const messages = [
      {
        id: 'assistant-url',
        role: 'assistant',
        content: '',
        status: 'streaming',
        blocks: [
          {
            id: 'request-user-input-0',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            renderPayload: payload,
          },
        ],
      },
    ] as WorkbenchMessage[]
    expect(pendingRequestUserInputPayload(messages)).toEqual(payload)
    expect(pendingRequestUserInputPayload(messages, new Set(['request:0']))).toBeNull()
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
            subtaskId: 1,
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
            subtaskId: 1,
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
            subtaskId: 1,
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

test('keeps consecutive async calls in arrival order with stable, distinct question IDs', () => {
  const first = {
    kind: 'request_user_input',
    delivery: 'async',
    itemId: 'first',
    questions: [{ id: 'question_1', question: 'First?' }],
  }
  const second = {
    kind: 'request_user_input',
    delivery: 'async',
    itemId: 'second',
    questions: [{ id: 'question_1', question: 'Second?' }],
  }
  const message = (payload: typeof first) =>
    ({
      id: payload.itemId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      blocks: [{ id: payload.itemId, type: 'tool', status: 'done', renderPayload: payload }],
    }) as WorkbenchMessage
  const before = pendingRequestUserInputPayload([message(first)])!
  const after = pendingRequestUserInputPayload([message(first), message(second)])!
  expect(after.itemId).toBe(before.itemId)
  expect(after.questions?.map(question => question.question)).toEqual(['First?', 'Second?'])
  expect(after.questions?.[0].id).toBe(before.questions?.[0].id)
  expect(new Set(after.questions?.map(question => question.id)).size).toBe(2)
  expect(
    pendingRequestUserInputPayload([message(first), message(second)], new Set(['item:first']))
  ).toEqual(second)
  expect(
    pendingRequestUserInputPayload([
      message(first),
      message(second),
      { id: 'reply', role: 'user', content: 'One\nTwo', status: 'done' } as WorkbenchMessage,
    ])
  ).toBeNull()
})
