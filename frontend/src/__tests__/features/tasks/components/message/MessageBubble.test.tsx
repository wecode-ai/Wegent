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

jest.mock('@/features/tasks/components/message/StreamingWaitIndicator', () => ({
  __esModule: true,
  default: () => null,
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

jest.mock('@/features/tasks/components/message/thinking', () => ({
  ReasoningDisplay: () => null,
}))

jest.mock('@/features/tasks/components/message/thinking/MixedContentView', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/message/thinking/ThinkingDisplay', () => ({
  __esModule: true,
  default: () => null,
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
})
