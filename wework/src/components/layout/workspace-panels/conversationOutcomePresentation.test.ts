import { expect, it } from 'vitest'
import type { RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'
import { conversationOutcomePresentation } from './conversationOutcomePresentation'

it('keeps native final text and questions without showing commentary, tools, reasoning or subagents', () => {
  const turn: RuntimeConversationTurn = {
    id: 'turn',
    status: 'done',
    streamingThinkingContent: '内部推理',
    items: [
      {
        id: 'receipt',
        type: 'assistant_text',
        content: '已接到任务',
        createdAt: '2026-11-09T00:00:00Z',
      },
      {
        id: 'progress',
        type: 'block',
        block: {
          id: 'progress',
          subtaskId: 'turn',
          createdAt: 0,
          status: 'done',
          type: 'text',
          content: '正在读取内部状态',
        },
      },
      {
        id: 'tool',
        type: 'block',
        block: {
          id: 'tool',
          subtaskId: 'turn',
          createdAt: 0,
          status: 'done',
          type: 'tool',
          toolName: 'exec_command',
          toolOutput: 'internal receipt',
        },
      },
      {
        id: 'agent',
        type: 'block',
        block: {
          id: 'agent',
          subtaskId: 'turn',
          createdAt: 0,
          status: 'done',
          type: 'subagent',
          title: '检索代理',
        },
      },
      {
        id: 'input',
        type: 'block',
        block: {
          id: 'input',
          subtaskId: 'turn',
          createdAt: 0,
          status: 'pending',
          type: 'tool',
          toolName: 'request_user_input',
          renderPayload: {
            kind: 'request_user_input',
            questions: [{ id: 'confirm', header: '选择', question: '需要哪一种？', options: [] }],
          },
        },
      },
      {
        id: 'result',
        type: 'assistant_text',
        content: '任务已完成',
        createdAt: '2026-11-09T00:01:00Z',
      },
    ],
  }
  const original = structuredClone(turn)
  const result = conversationOutcomePresentation([], [turn])
  expect(result.turns[0].items.map(item => item.id)).toEqual(['receipt', 'input', 'result'])
  expect(
    result.messages
      .filter(message => message.role === 'assistant')
      .map(message => message.content)
      .join(' ')
  ).toContain('任务已完成')
  expect(result.turns[0].streamingThinkingContent).toBeUndefined()
  expect(turn).toEqual(original)
})

it('preserves turn failures and message identities while leaving the stored transcript untouched', () => {
  const message = {
    id: 'failed',
    role: 'assistant',
    content: '',
    status: 'failed',
    error: '设备已离线',
    createdAt: '',
    blocks: [
      {
        id: 'reasoning',
        type: 'thinking',
        content: '内部推理',
        subtaskId: 'turn',
        status: 'done',
        createdAt: 0,
      },
    ],
    streamingThinkingContent: '未完成的推理',
  } as WorkbenchMessage
  const result = conversationOutcomePresentation([message], [])
  expect(result.messages[0]).toMatchObject({
    id: 'failed',
    status: 'failed',
    error: '设备已离线',
    blocks: [],
  })
  expect(message.blocks).toHaveLength(1)
  expect(message.streamingThinkingContent).toBe('未完成的推理')
})

it('shows the opening acknowledgement while work runs, but not later progress', () => {
  const text = (id: string, content: string) => ({
    id,
    type: 'block' as const,
    block: {
      id,
      type: 'text' as const,
      content,
      subtaskId: 'turn',
      status: 'done' as const,
      createdAt: 0,
    },
  })
  const turn: RuntimeConversationTurn = {
    id: 'turn',
    status: 'running',
    items: [
      text('receipt', '收到，我来设置新版本提醒。'),
      {
        id: 'tool',
        type: 'block',
        block: {
          id: 'tool',
          type: 'tool',
          toolName: 'check',
          subtaskId: 'turn',
          status: 'streaming',
          createdAt: 1,
        },
      },
      text('progress', '正在检查第二个来源'),
    ],
  }
  const result = conversationOutcomePresentation([], [turn])
  expect(result.turns[0].status).toBe('running')
  expect(result.turns[0].items.map(item => item.id)).toEqual(['receipt'])
  expect(result.messages[0].content).toContain('收到，我来设置新版本提醒。')
  expect(turn.items).toHaveLength(3)
})
