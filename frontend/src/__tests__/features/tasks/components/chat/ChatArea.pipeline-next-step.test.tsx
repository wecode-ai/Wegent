// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ChatArea } from '@/features/tasks/components/chat'
import type { Team } from '@/types/api'

const mockSendMessage = jest.fn()
const mockToast = jest.fn()

const mockSelectedTeam = {
  id: 7,
  name: 'Pipeline Team',
  agent_type: 'chat',
  workflow: { mode: 'pipeline' },
} as unknown as Team

const mockSelectedTaskDetail = {
  id: 42,
  title: 'Pipeline task',
  status: 'PENDING_CONFIRMATION',
  team: mockSelectedTeam,
  is_group_chat: false,
  requested_skills: [],
}

let mockTaskMessages = new Map<string, unknown>()

const mockStageInfo = {
  current_stage: 0,
  total_stages: 2,
  current_stage_name: 'Design',
  is_pending_confirmation: true,
  stages: [
    {
      index: 0,
      name: 'Design',
      require_confirmation: true,
      status: 'pending_confirmation',
    },
    {
      index: 1,
      name: 'Build',
      require_confirmation: false,
      status: 'pending',
    },
  ],
}

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('taskId=42'),
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/chat',
}))

const mockTranslations: Record<string, Record<string, string>> = {
  chat: {
    'pipeline.stage_confirmed': 'Stage Confirmed',
    'pipeline.confirm_failed': 'Failed to confirm stage',
    'pipeline.next_step_dialog.missing_task': 'Task or team information is unavailable',
  },
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string) => {
      if (key.includes(':')) {
        const [keyNamespace, namespacedKey] = key.split(':')
        return mockTranslations[keyNamespace]?.[namespacedKey] ?? key
      }

      return mockTranslations[namespace ?? 'common']?.[key] ?? key
    },
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/features/tasks/components/chat/useChatAreaState', () => ({
  useChatAreaState: () => ({
    selectedTeam: mockSelectedTeam,
    handleTeamChange: jest.fn(),
    findDefaultTeamForMode: jest.fn(),
    defaultTeam: null,
    restoreDefaultTeam: jest.fn(),
    isUsingDefaultTeam: false,
    selectedModel: null,
    setSelectedModel: jest.fn(),
    forceOverride: false,
    setForceOverride: jest.fn(),
    selectedRepo: null,
    setSelectedRepo: jest.fn(),
    selectedBranch: null,
    setSelectedBranch: jest.fn(),
    effectiveRequiresWorkspace: false,
    setRequiresWorkspaceOverride: jest.fn(),
    taskInputMessage: '',
    setTaskInputMessage: jest.fn(),
    setIsLoading: jest.fn(),
    isLoading: false,
    enableDeepThinking: false,
    setEnableDeepThinking: jest.fn(),
    enableClarification: false,
    setEnableClarification: jest.fn(),
    enableCorrectionMode: false,
    enableCorrectionWebSearch: false,
    correctionModelId: null,
    correctionModelName: null,
    handleCorrectionModeToggle: jest.fn(),
    externalApiParams: {},
    handleExternalApiParamsChange: jest.fn(),
    handleAppModeChange: jest.fn(),
    attachmentState: { attachments: [], uploadingFiles: new Map(), errors: new Map() },
    resetAttachment: jest.fn(),
    isAttachmentReadyToSend: true,
    shouldHideQuotaUsage: false,
    shouldHideChatInput: false,
    selectedContexts: [],
    resetContexts: jest.fn(),
    setSelectedContexts: jest.fn(),
    addExistingAttachment: jest.fn(),
    handleFileSelect: jest.fn(),
    handleAttachmentRemove: jest.fn(),
    setIsDragging: jest.fn(),
    isDragging: false,
    randomTip: 'tip',
    randomSlogan: 'slogan',
  }),
}))

jest.mock('@/features/tasks/components/chat/useChatStreamHandlers', () => ({
  useChatStreamHandlers: () => ({
    pendingTaskId: null,
    isStreaming: false,
    isAwaitingResponseStart: false,
    isSubtaskStreaming: false,
    isStopping: false,
    hasPendingUserMessage: false,
    localPendingMessage: null,
    handleSendMessage: jest.fn(),
    handleSendMessageWithModel: jest.fn(),
    handleRetry: jest.fn(),
    handleCancelTask: jest.fn(),
    stopStream: jest.fn(),
    resetStreamingState: jest.fn(),
    handleNewMessages: jest.fn(),
    handleStreamComplete: jest.fn(),
    isCancelling: false,
  }),
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    selectedTaskDetail: mockSelectedTaskDetail,
    setSelectedTask: jest.fn(),
    accessDenied: false,
  }),
}))

jest.mock('@/features/projects/contexts/projectContext', () => ({
  useProjectContext: () => ({
    projects: [],
    projectTaskIds: new Set(),
    isWorkspaceEnabled: false,
  }),
}))

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useOptionalChatStreamContext: () => ({
    sendMessage: mockSendMessage,
  }),
}))

jest.mock('@/features/tasks/hooks/useTaskStateMachine', () => ({
  useTaskStateMachine: () => ({
    state: { messages: mockTaskMessages },
  }),
}))

jest.mock(
  '@/features/tasks/components/chat/PipelineStageIndicator',
  () =>
    function MockPipelineStageIndicator({
      canContinueToNextStage,
      onNextStepClick,
      onStageInfoChange,
    }: {
      canContinueToNextStage?: boolean
      onNextStepClick?: (stageInfo: typeof mockStageInfo) => void
      onStageInfoChange?: (stageInfo: typeof mockStageInfo) => void
    }) {
      return (
        <button
          type="button"
          data-testid="pipeline-next-step-button"
          disabled={canContinueToNextStage === false}
          onClick={() => {
            onStageInfoChange?.(mockStageInfo)
            onNextStepClick?.(mockStageInfo)
          }}
        >
          next
        </button>
      )
    }
)

jest.mock(
  '@/features/tasks/components/message/MessagesArea',
  () =>
    function MockMessagesArea() {
      return <div data-testid="messages-area" />
    }
)
jest.mock('@/features/tasks/components/chat/QuickAccessCards', () => ({
  QuickAccessCards: () => <div data-testid="quick-access-cards" />,
}))
jest.mock('@/features/tasks/components/chat/SloganDisplay', () => ({
  SloganDisplay: () => <div data-testid="slogan-display" />,
}))
jest.mock('@/features/tasks/components/input/ChatInputCard', () => ({
  ChatInputCard: () => <div data-testid="chat-input-card" />,
}))
jest.mock('@/features/tasks/components/chat/ScrollToBottomIndicator', () => ({
  ScrollToBottomIndicator: () => <div data-testid="scroll-to-bottom-indicator" />,
}))
jest.mock('@/features/tasks/components/chat/ScrollbarMarkers', () => ({
  ScrollbarMarkers: () => <div data-testid="scrollbar-markers" />,
}))
jest.mock('@/features/knowledge/document/components/GuidedQuestions', () => ({
  GuidedQuestions: () => <div data-testid="guided-questions" />,
}))
jest.mock('@/features/tasks/components/text-selection', () => ({
  QuoteProvider: function MockQuoteProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>
  },
  SelectionTooltip: function MockSelectionTooltip() {
    return null
  },
  useQuote: () => ({
    quote: null,
    clearQuote: jest.fn(),
    formatQuoteForMessage: (message: string) => message,
  }),
}))
jest.mock('@/features/tasks/components/hooks/useScrollManagement', () => ({
  useScrollManagement: () => ({
    scrollContainerRef: { current: null },
    isUserNearBottomRef: { current: true },
    showScrollIndicator: false,
    scrollToBottom: jest.fn(),
    handleMessagesContentChange: jest.fn(),
  }),
}))
jest.mock('@/features/tasks/components/hooks/useFloatingInput', () => ({
  useFloatingInput: () => ({
    chatAreaRef: { current: null },
    floatingInputRef: { current: null },
    inputControlsRef: { current: null },
    floatingMetrics: { left: 0, width: 0 },
    inputHeight: 0,
    controlsContainerWidth: 0,
  }),
}))
jest.mock('@/apis/attachments', () => ({
  getAttachment: jest.fn(),
}))
jest.mock('@/features/tasks/components/hooks/useAttachmentUpload', () => ({
  useAttachmentUpload: () => ({
    handleDragEnter: jest.fn(),
    handleDragLeave: jest.fn(),
    handleDragOver: jest.fn(),
    handleDrop: jest.fn(),
    handlePasteFile: jest.fn(),
  }),
}))
jest.mock('@/lib/scheme', () => ({
  useSchemeMessageActions: jest.fn(),
}))
jest.mock('@/features/tasks/components/params', () => ({
  QueryParamAutoSend: () => <div data-testid="query-param-auto-send" />,
}))
jest.mock('@/features/tasks/hooks/useSkillSelector', () => ({
  useSkillSelector: () => ({
    availableSkills: [],
    teamSkillNames: [],
    preloadedSkillNames: [],
    selectedSkillNames: [],
    selectedSkills: [],
    toggleSkill: jest.fn(),
  }),
}))
jest.mock('@/features/tasks/hooks/useModelSelection', () => ({
  useModelSelection: () => ({
    selectedModel: null,
    isLoading: false,
    selectModelByKey: jest.fn(),
  }),
}))
jest.mock('@/features/tasks/components/selector/ModelSelector', () => ({
  allBotsHavePredefinedModel: () => true,
}))
jest.mock('@/features/inbox', () => ({
  QueueMessageHandler: () => <div data-testid="queue-message-handler" />,
}))

function setCompletedPipelineMessages() {
  mockTaskMessages = new Map([
    [
      'user-1',
      {
        id: 'user-1',
        type: 'user',
        status: 'completed',
        content: 'Original request',
        timestamp: 1,
        contexts: [
          {
            id: 10,
            context_type: 'attachment',
            name: 'spec.md',
            status: 'ready',
          },
          {
            id: 200,
            context_type: 'knowledge_base',
            name: 'Product KB',
            status: 'ready',
            knowledge_id: 20,
            document_count: 3,
          },
        ],
      },
    ],
    [
      'ai-1',
      {
        id: 'ai-1',
        type: 'ai',
        status: 'completed',
        content: ['## Final Requirement Prompt', 'Build this feature'].join('\n'),
        timestamp: 2,
      },
    ],
  ])
}

describe('ChatArea pipeline next-step dialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendMessage.mockResolvedValue(42)
    setCompletedPipelineMessages()
  })

  it('opens the context picker and confirms the next pipeline step with selected context', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    render(<ChatArea teams={[mockSelectedTeam]} isTeamsLoading={false} taskType="chat" />)

    await user.click(await screen.findByTestId('pipeline-next-step-button'))

    expect(screen.getByTestId('pipeline-next-step-message')).toHaveValue('')

    await user.click(screen.getByTestId('pipeline-next-step-confirm-button'))

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1))

    const [request, options] = mockSendMessage.mock.calls[0]
    expect(request).toMatchObject({
      task_id: 42,
      team_id: 7,
      action: 'pipeline:confirm',
      attachment_ids: [10],
      contexts: [
        {
          type: 'knowledge_base',
          data: {
            knowledge_id: 20,
            name: 'Product KB',
            document_count: 3,
          },
        },
      ],
    })
    expect(request.message).toContain('Previous pipeline context:')
    expect(request.message).toContain('[AI]\nBuild this feature')
    expect(request.message).not.toContain('[User]\nOriginal request')
    expect(options).toMatchObject({
      pendingUserMessage: expect.stringContaining('[AI]\nBuild this feature'),
      immediateTaskId: 42,
      pendingContexts: [
        expect.objectContaining({ id: 10, context_type: 'attachment' }),
        expect.objectContaining({
          id: 200,
          context_type: 'knowledge_base',
          knowledge_id: 20,
        }),
      ],
    })
    expect(mockToast).toHaveBeenCalledWith({ title: 'Stage Confirmed' })
  })

  it('disables the indicator action when there is no completed AI handoff', async () => {
    mockTaskMessages = new Map([
      [
        'user-1',
        {
          id: 'user-1',
          type: 'user',
          status: 'completed',
          content: 'Original request',
          timestamp: 1,
        },
      ],
    ])

    render(<ChatArea teams={[mockSelectedTeam]} isTeamsLoading={false} taskType="chat" />)

    expect(await screen.findByTestId('pipeline-next-step-button')).toBeDisabled()
  })
})
