import '@/i18n'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { SubagentBlock, WorkbenchMessage } from '@/types/workbench'
import {
  SubagentConversationPanel,
  SubagentEnvironmentSummary,
  SubagentOverviewPanel,
} from './SubagentConversationPanel'

function createSubagent(overrides: Partial<SubagentBlock> = {}): SubagentBlock {
  return {
    id: 'subagent-1',
    subtaskId: 'turn-1',
    type: 'subagent',
    agentThreadId: 'thread-1',
    agentType: 'Explorer',
    description: 'Inspect the event stream',
    status: 'streaming',
    createdAt: 1770000000000,
    children: [
      {
        id: 'child-text-1',
        subtaskId: 'turn-1',
        parentToolUseId: 'subagent-1',
        type: 'text',
        content: 'Reading the runtime events',
        status: 'streaming',
        createdAt: 1770000000100,
      },
    ],
    ...overrides,
  }
}

describe('SubagentConversationPanel', () => {
  test('updates the child reasoning content in place while streaming', async () => {
    const props = { onBack: vi.fn(), onOpenSubagent: vi.fn() }
    const reasoning = {
      id: 'child-reasoning',
      subtaskId: 'turn-1',
      type: 'thinking' as const,
      content: 'Inspecting',
      status: 'streaming' as const,
      createdAt: 1770000000100,
    }
    const view = render(
      <SubagentConversationPanel {...props} block={createSubagent({ children: [reasoning] })} />
    )
    expect(screen.getByTestId('process-thinking-block')).toHaveTextContent('Inspecting')

    view.rerender(
      <SubagentConversationPanel
        {...props}
        block={createSubagent({
          children: [{ ...reasoning, content: 'Inspecting the event routing' }],
        })}
      />
    )
    expect(screen.getAllByTestId('process-thinking-block')).toHaveLength(1)
    await waitFor(() => {
      expect(screen.getByTestId('process-thinking-block')).toHaveTextContent(
        'Inspecting the event routing'
      )
    })
  })

  test.each(['streaming', 'done'] as const)(
    'renders child reasoning and commentary around tools while %s',
    status => {
      const children: NonNullable<SubagentBlock['children']> = [
        {
          id: 'reasoning',
          subtaskId: 'turn-1',
          type: 'thinking',
          content: 'Checking the child routing',
          status: 'done',
          createdAt: 1770000000100,
        },
        {
          id: 'commentary',
          subtaskId: 'turn-1',
          type: 'text',
          content: 'Reading the runtime events',
          status: 'done',
          createdAt: 1770000000200,
        },
        {
          id: 'tool',
          subtaskId: 'turn-1',
          type: 'tool',
          toolName: 'exec_command',
          toolInput: { command: 'rg child' },
          status,
          createdAt: 1770000000300,
        },
      ]
      render(
        <SubagentConversationPanel
          block={createSubagent({ status, children })}
          onBack={vi.fn()}
          onOpenSubagent={vi.fn()}
          transcriptMessages={
            status === 'done'
              ? [
                  {
                    id: 'history',
                    role: 'assistant',
                    content: '',
                    status,
                    createdAt: '2026-09-10T08:00:01.000Z',
                    blocks: children,
                  },
                ]
              : []
          }
        />
      )
      const panel = screen.getByTestId('subagent-conversation-scroll')
      expect(panel).toHaveTextContent('Checking the child routing')
      expect(panel).toHaveTextContent('Reading the runtime events')
      const blocks = panel.querySelectorAll('[data-processing-block-id]')
      expect(
        Array.from(blocks, element => element.getAttribute('data-processing-block-id')).slice(0, 2)
      ).toEqual(['reasoning', 'commentary'])
    }
  )

  test('renders the ChatGPT-style subagent summary inside the environment panel', () => {
    const onOpen = vi.fn()
    render(
      <SubagentEnvironmentSummary
        blocks={[
          createSubagent(),
          createSubagent({
            id: 'subagent-2',
            agentThreadId: 'thread-2',
            status: 'done',
          }),
        ]}
        onOpen={onOpen}
      />
    )

    expect(screen.getByTestId('environment-subagents-section')).toHaveTextContent('子代理')
    expect(screen.getByTestId('open-subagents-panel-button')).toHaveTextContent(
      '1 工作中 · 1 已完成'
    )

    fireEvent.click(screen.getByTestId('open-subagents-panel-button'))

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('lists active and completed subagents before opening a conversation', () => {
    const onSelect = vi.fn()
    render(
      <SubagentOverviewPanel
        blocks={[
          createSubagent(),
          createSubagent({
            id: 'subagent-2',
            agentThreadId: 'thread-2',
            agentType: 'Reviewer',
            description: 'Review the implementation',
            status: 'done',
          }),
        ]}
        onSelect={onSelect}
      />
    )

    expect(screen.getByText('进行中 · 1')).toBeInTheDocument()
    expect(screen.getByText('已完成 · 1')).toBeInTheDocument()
    expect(screen.getByText('Inspect the event stream')).toBeInTheDocument()
    expect(screen.getByText('Review the implementation')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开 Review the implementation 子代理' }))

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'subagent-2' }))
  })

  test('lists failed subagents with completed work instead of active work', () => {
    render(
      <SubagentOverviewPanel
        blocks={[
          createSubagent({
            description: undefined,
            status: 'error',
            agentStatus: 'interrupted',
          }),
        ]}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText('进行中 · 0')).toBeInTheDocument()
    expect(screen.getByText('已完成 · 1')).toBeInTheDocument()
    expect(screen.getByText('已中断')).toBeInTheDocument()
    expect(screen.queryByText('正在工作')).not.toBeInTheDocument()
  })

  test('renders the delegated prompt and streams child conversation updates', async () => {
    const onBack = vi.fn()
    const onOpenSubagent = vi.fn()
    const view = render(
      <SubagentConversationPanel
        block={createSubagent()}
        onBack={onBack}
        onOpenSubagent={onOpenSubagent}
      />
    )

    expect(screen.getByTestId('subagent-conversation-panel')).toHaveTextContent(
      'Inspect the event stream'
    )
    expect(screen.getByTestId('subagent-conversation-delegation')).toHaveTextContent(
      'Inspect the event stream'
    )
    expect(screen.getByTestId('subagent-conversation-scroll')).toHaveTextContent(
      'Reading the runtime events'
    )

    view.rerender(
      <SubagentConversationPanel
        block={createSubagent({
          children: [
            {
              id: 'child-text-1',
              subtaskId: 'turn-1',
              parentToolUseId: 'subagent-1',
              type: 'text',
              content: 'Reading the runtime events\n\nFound the child delta route',
              status: 'streaming',
              createdAt: 1770000000100,
            },
          ],
        })}
        onBack={onBack}
        onOpenSubagent={onOpenSubagent}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('subagent-conversation-scroll')).toHaveTextContent(
        'Found the child delta route'
      )
    })
    fireEvent.click(screen.getByTestId('subagent-conversation-back'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('opens a nested subagent conversation from the child thread', () => {
    const onOpenSubagent = vi.fn()
    render(
      <SubagentConversationPanel
        block={createSubagent({
          children: [
            {
              id: 'nested-agent',
              subtaskId: 'turn-1',
              parentToolUseId: 'subagent-1',
              type: 'subagent',
              agentType: 'Reviewer',
              status: 'streaming',
              createdAt: 1770000000200,
            },
          ],
        })}
        onBack={vi.fn()}
        onOpenSubagent={onOpenSubagent}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '打开 Reviewer 子代理' }))

    expect(onOpenSubagent).toHaveBeenCalledWith(expect.objectContaining({ id: 'nested-agent' }))
  })

  test('renders persisted child-thread history after the parent task is restored', () => {
    const transcriptMessages: WorkbenchMessage[] = [
      {
        id: 'child-user',
        role: 'user',
        content: 'Say hello',
        status: 'done',
        createdAt: '2026-09-10T08:00:00.000Z',
      },
      {
        id: 'child-assistant',
        role: 'assistant',
        content: 'hello from persisted child history',
        status: 'done',
        createdAt: '2026-09-10T08:00:01.000Z',
      },
    ]

    render(
      <SubagentConversationPanel
        block={createSubagent({
          agentType: undefined,
          title: 'say_hello',
          status: 'done',
          children: [],
          output: undefined,
        })}
        transcriptMessages={transcriptMessages}
        onBack={vi.fn()}
        onOpenSubagent={vi.fn()}
      />
    )

    expect(screen.getByTestId('subagent-conversation-panel')).toHaveTextContent('say_hello')
    expect(screen.getByTestId('subagent-transcript-message')).toHaveTextContent(
      'hello from persisted child history'
    )
    expect(screen.queryByTestId('subagent-conversation-empty')).not.toBeInTheDocument()
  })

  test('prefers live child output over an incomplete transcript snapshot while running', () => {
    render(
      <SubagentConversationPanel
        block={createSubagent({
          children: [
            {
              id: 'child-text-live',
              subtaskId: 'turn-1',
              parentToolUseId: 'subagent-1',
              type: 'text',
              content: 'Newest live child output',
              status: 'streaming',
              createdAt: 1770000000200,
            },
          ],
        })}
        transcriptMessages={[
          {
            id: 'child-assistant-stale',
            role: 'assistant',
            content: 'Older transcript snapshot',
            status: 'streaming',
            createdAt: '2026-09-10T08:00:01.000Z',
          },
        ]}
        onBack={vi.fn()}
        onOpenSubagent={vi.fn()}
      />
    )

    expect(screen.getByTestId('subagent-conversation-scroll')).toHaveTextContent(
      'Newest live child output'
    )
    expect(screen.queryByText('Older transcript snapshot')).not.toBeInTheDocument()
  })
})
