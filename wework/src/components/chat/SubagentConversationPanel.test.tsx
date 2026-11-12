import '@/i18n'

import type { SubagentBlock, WorkbenchMessage } from '@/types/workbench'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SubagentConversationPanel, SubagentOverviewPanel } from './SubagentConversationPanel'

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
  test.each(['streaming'] as const)(
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
})
