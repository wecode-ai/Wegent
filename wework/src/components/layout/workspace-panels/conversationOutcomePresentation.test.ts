import { expect, it } from 'vitest'
import type { RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'
import { conversationOutcomePresentation } from './conversationOutcomePresentation'

it('removes guidance blocks generated during projection without losing either user message', () => {
  const user = (id: string, content: string, runtimeGuidance = false) => ({
    id,
    type: 'user_message' as const,
    message: { id, role: 'user' as const, content, status: 'done' as const, runtimeGuidance },
  })
  const turn: RuntimeConversationTurn = {
    id: 'native-turn',
    status: 'streaming',
    startedAt: 1000,
    items: [
      user('first', '查一下发布情况'),
      { id: 'ack', type: 'assistant_text', content: '我来查。', createdAt: '' },
      user('next', '也看看 Windows 版本', true),
      { id: 'reply', type: 'assistant_text', content: '收到。', createdAt: '' },
    ],
  }
  const result = conversationOutcomePresentation([], [turn])
  expect(
    result.messages.filter(message => message.role === 'user').map(message => message.content)
  ).toEqual(['查一下发布情况', '也看看 Windows 版本'])
  expect(result.messages.flatMap(message => message.blocks ?? [])).toEqual([])
  expect(
    result.messages
      .flatMap(message => message.runtimeDisplayItems ?? [])
      .some(item => item.type === 'block')
  ).toBe(false)
  expect(turn.items[2]).toMatchObject({ message: { runtimeGuidance: true } })
})

it('keeps native assistant item identities as separate replies across live updates and completion', () => {
  const ack = {
    id: 'ack',
    type: 'assistant_text' as const,
    content: '我来查。',
    createdAt: '2026-11-09T00:00:00Z',
  }
  const turn: RuntimeConversationTurn = {
    id: 'native',
    status: 'streaming',
    items: [
      ack,
      {
        id: 'child',
        type: 'block',
        block: {
          id: 'child',
          subtaskId: 'native',
          type: 'subagent',
          title: '检查',
          status: 'streaming',
          createdAt: 0,
        },
      },
    ],
  }
  const before = conversationOutcomePresentation([], [turn]).messages
  const pending = {
    id: 'final',
    type: 'assistant_text' as const,
    content: '',
    createdAt: '2026-11-09T00:01:00Z',
  }
  turn.items.push(pending)
  const streaming = conversationOutcomePresentation([], [turn]).messages
  expect(streaming).toHaveLength(1)
  expect(streaming[0].id).toBe(before[0].id)
  turn.items.pop()
  turn.items.push({
    id: 'final',
    type: 'assistant_text',
    content: '结果第一段。\n\n结果第二段。',
    createdAt: '2026-11-09T00:01:00Z',
  })
  turn.status = 'failed'
  turn.error = '连接中断'
  const after = conversationOutcomePresentation([], [turn]).messages
  expect(after.map(message => message.content)).toEqual([
    '我来查。',
    '结果第一段。\n\n结果第二段。',
  ])
  expect(after[0].id).toBe(before[0].id)
  expect(after[0].runtimeDisplayItems).toEqual([
    { id: 'ack', type: 'assistant_text', content: ack.content },
  ])
  expect(after[0].error).toBeUndefined()
  expect(after[1]).toMatchObject({
    status: 'failed',
    error: '连接中断',
    createdAt: '2026-11-09T00:01:00Z',
  })
})

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
