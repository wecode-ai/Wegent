import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import MessageBubble, { type Message } from '@/features/tasks/components/message/MessageBubble'
import type { Team } from '@/types/api'

jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({
    trace: { event: jest.fn(), copy: jest.fn(), download: jest.fn() },
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

jest.mock('@/components/common/SmartUrlRenderer', () => ({
  SmartLink: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  SmartImage: () => null,
  SmartTextLine: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
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
  __esModule: true,
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

jest.mock('@/features/tasks/components/message/FinalPromptMessage', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/clarification', () => ({
  AskUserForm: () => null,
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

describe('MessageBubble timing summary', () => {
  it('does not automatically render the legacy timing overview', () => {
    const msg: Message = {
      type: 'ai',
      content: 'Timing result',
      timestamp: Date.now(),
      subtaskStatus: 'COMPLETED',
      status: 'completed',
      result: {
        timing: {
          queueDurationMs: 1,
          createDurationMs: 2,
          waitReadyDurationMs: 3,
          dispatchDurationMs: 4,
          agentDurationMs: 5,
        },
      },
    }
    const team: Team = {
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
    }

    render(
      <MessageBubble
        msg={msg}
        index={0}
        selectedTaskDetail={null}
        selectedTeam={team}
        theme="light"
        t={key => key}
      />
    )

    expect(screen.getByText('Timing result')).toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-overview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-timing-overview-toggle')).not.toBeInTheDocument()
  })
})
