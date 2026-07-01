// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { render, screen } from '@testing-library/react'

import MessageBubble, { type Message } from '@/features/tasks/components/message/MessageBubble'
import type { Team } from '@/types/api'

jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({
    trace: {
      event: jest.fn(),
      copy: jest.fn(),
      download: jest.fn(),
    },
  }),
}))

jest.mock('@/hooks/useMessageFeedback', () => ({
  useMessageFeedback: () => ({
    feedback: null,
    handleLike: jest.fn(),
    handleDislike: jest.fn(),
  }),
}))

jest.mock('@/contexts/ShareTokenContext', () => ({
  ShareTokenProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

jest.mock('@/features/tasks/components/message/ContextBadgeList', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/message/BubbleTools', () => ({
  __esModule: true,
  default: () => null,
  CopyButton: () => null,
  EditButton: () => null,
}))

const mockStreamingWaitIndicator = jest.fn()

jest.mock('@/features/tasks/components/message/StreamingWaitIndicator', () => ({
  __esModule: true,
  default: (props: { message?: string }) => {
    mockStreamingWaitIndicator(props)
    return <div data-testid="streaming-wait-indicator">{props.message || 'waiting'}</div>
  },
}))

jest.mock('@/features/tasks/components/message/InlineMessageEdit', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/message/RegenerateModelPopover', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/message/VideoConfigBadge', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/message/ErrorCard', () => ({
  ErrorCard: () => null,
}))

const mockReasoningDisplay = jest.fn()
const mockMixedContentView = jest.fn()
const mockThinkingDisplay = jest.fn()

jest.mock('@/features/tasks/components/message/thinking', () => ({
  ReasoningDisplay: (props: { reasoningContent: string; isStreaming?: boolean }) => {
    mockReasoningDisplay(props)
    return <div data-testid="reasoning-display">{props.reasoningContent}</div>
  },
}))

jest.mock('@/features/tasks/components/message/thinking/MixedContentView', () => ({
  __esModule: true,
  default: (props: { blocks?: Array<{ type: string; content?: string }> }) => {
    mockMixedContentView(props)
    return <div data-testid="mixed-content-view" />
  },
}))

jest.mock('@/features/tasks/components/message/thinking/ThinkingDisplay', () => ({
  __esModule: true,
  default: (props: { thinking?: unknown[] }) => {
    mockThinkingDisplay(props)
    return <div data-testid="thinking-display" />
  },
}))

jest.mock('@/features/tasks/components/clarification/ClarificationForm', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/clarification', () => ({
  AskUserForm: () => null,
}))

jest.mock('@/features/tasks/components/message/FinalPromptMessage', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/clarification/ClarificationAnswerSummary', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/chat/SourceReferences', () => ({
  SourceReferences: () => null,
}))

jest.mock('@/features/tasks/components/chat/GeminiAnnotations', () => ({
  GeminiAnnotations: () => null,
}))

jest.mock('@/features/tasks/components/message/CollapsibleMessage', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const t = (key: string) => key

const makeTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 1,
  name: 'internal-agent-name',
  displayName: null,
  description: '',
  bots: [],
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('MessageBubble', () => {
  beforeEach(() => {
    mockReasoningDisplay.mockClear()
    mockMixedContentView.mockClear()
    mockThinkingDisplay.mockClear()
    mockStreamingWaitIndicator.mockClear()
  })

  it('shows the selected agent displayName for AI message headers', () => {
    const msg: Message = {
      type: 'ai',
      content: '${$$}$hello',
      timestamp: new Date('2026-01-01T00:00:00Z').getTime(),
      botName: 'internal-agent-name',
      subtaskStatus: 'COMPLETED',
      status: 'completed',
    }

    render(
      <MessageBubble
        msg={msg}
        index={0}
        selectedTaskDetail={null}
        selectedTeam={makeTeam({ displayName: 'Friendly Agent' })}
        theme="light"
        t={t}
      />
    )

    expect(screen.getByText('Friendly Agent')).toBeInTheDocument()
    expect(screen.queryByText('internal-agent-name')).not.toBeInTheDocument()
  })

  it('shows the bot name with the agent displayName for multi-bot teams', () => {
    const msg: Message = {
      type: 'ai',
      content: '${$$}$hello',
      timestamp: new Date('2026-01-01T00:00:00Z').getTime(),
      botName: 'Planner Bot',
      subtaskStatus: 'COMPLETED',
      status: 'completed',
    }

    render(
      <MessageBubble
        msg={msg}
        index={0}
        selectedTaskDetail={null}
        selectedTeam={makeTeam({
          displayName: 'Friendly Agent',
          bots: [
            { bot_id: 1, bot_prompt: '' },
            { bot_id: 2, bot_prompt: '' },
          ],
        })}
        theme="light"
        t={t}
      />
    )

    expect(screen.getByText('Friendly Agent · Planner Bot')).toBeInTheDocument()
  })

  it('shows inline thinking blocks with the ChatShell reasoning display and omits them from mixed content', () => {
    const msg: Message = {
      type: 'ai',
      content: '',
      timestamp: new Date('2026-01-01T00:00:00Z').getTime(),
      botName: 'Claude Bot',
      subtaskStatus: 'RUNNING',
      status: 'streaming',
      result: {
        blocks: [
          {
            id: 'thinking-1',
            type: 'thinking',
            status: 'streaming',
            content: 'I need to inspect the current directory.',
          },
          {
            id: 'text-1',
            type: 'text',
            status: 'streaming',
            content: 'Visible answer',
          },
        ],
      },
    }

    render(
      <MessageBubble
        msg={msg}
        index={0}
        selectedTaskDetail={null}
        selectedTeam={makeTeam()}
        theme="light"
        t={t}
      />
    )

    expect(screen.getByTestId('reasoning-display')).toHaveTextContent(
      'I need to inspect the current directory.'
    )
    expect(mockReasoningDisplay).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningContent: 'I need to inspect the current directory.',
        isStreaming: true,
      })
    )
    expect(mockMixedContentView).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            id: 'text-1',
            type: 'text',
            content: 'Visible answer',
          }),
        ],
      })
    )
  })

  it('renders tool usage from thinking when device messages also contain content blocks', () => {
    const msg: Message = {
      type: 'ai',
      content: '',
      timestamp: new Date('2026-01-01T00:00:00Z').getTime(),
      botName: 'Claude Bot',
      subtaskStatus: 'RUNNING',
      status: 'streaming',
      thinking: [
        {
          title: 'Using Write',
          next_action: 'continue',
          tool_use_id: 'tool-write-1',
          details: {
            type: 'tool_use',
            tool_name: 'Write',
            status: 'started',
            input: { file_path: 'PROJECT_INTRO.md' },
          },
        },
        {
          title: 'Result from Write',
          next_action: 'continue',
          tool_use_id: 'tool-write-1',
          details: {
            type: 'tool_result',
            tool_name: 'Write',
            status: 'completed',
            content: 'created',
          },
        },
      ],
      result: {
        blocks: [
          {
            id: 'thinking-1',
            type: 'thinking',
            status: 'done',
            content: 'I need to create a project intro document.',
          },
          {
            id: 'text-1',
            type: 'text',
            status: 'streaming',
            content: 'I will create the document.',
          },
        ],
      },
    }

    render(
      <MessageBubble
        msg={msg}
        index={0}
        selectedTaskDetail={null}
        selectedTeam={makeTeam()}
        theme="light"
        t={t}
      />
    )

    expect(screen.getByTestId('thinking-display')).toBeInTheDocument()
    expect(mockThinkingDisplay).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: msg.thinking,
      })
    )
    expect(mockMixedContentView).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            id: 'text-1',
            type: 'text',
          }),
        ],
      })
    )
  })

  it('uses the ChatShell reasoning display for empty streaming wait states', () => {
    const msg: Message = {
      type: 'ai',
      content: '',
      timestamp: new Date('2026-01-01T00:00:00Z').getTime(),
      botName: 'Claude Bot',
      subtaskStatus: 'RUNNING',
      status: 'streaming',
    }

    render(
      <MessageBubble
        msg={msg}
        index={0}
        selectedTaskDetail={null}
        selectedTeam={makeTeam()}
        theme="light"
        t={t}
        isWaiting={true}
        waitingMessage="正在思考"
      />
    )

    expect(screen.getByTestId('reasoning-display')).toHaveTextContent('正在思考')
    expect(mockReasoningDisplay).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningContent: '正在思考',
        isStreaming: true,
      })
    )
    expect(screen.queryByTestId('streaming-wait-indicator')).not.toBeInTheDocument()
    expect(mockStreamingWaitIndicator).not.toHaveBeenCalled()
  })
})
