// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ChatArea } from '@/features/tasks/components/chat'
import type { Team, TaskType } from '@/types/api'

const mockSendMessage = jest.fn()
const mockHandleSendMessage = jest.fn()
const mockToast = jest.fn()
const mockSetSelectedDeviceId = jest.fn()
const mockRouter = { push: jest.fn(), replace: jest.fn() }

const mockSelectedTeam = {
  id: 7,
  name: 'Pipeline Team',
  agent_type: 'chat',
  workflow: { mode: 'pipeline' },
  bots: [
    {
      bot_id: 10,
      bot_prompt: 'Stage one',
      requireConfirmation: true,
      contextPassing: 'previous_bot',
    },
    {
      bot_id: 20,
      bot_prompt: 'Stage two',
      requireConfirmation: false,
      contextPassing: 'none',
    },
  ],
} as unknown as Team

const mockSelectedTaskDetail = {
  id: 42,
  title: 'Pipeline task',
  status: 'PENDING_CONFIRMATION',
  team: mockSelectedTeam,
  is_group_chat: false,
  requested_skills: [],
}

let mockChatAreaTeam = mockSelectedTeam
let mockNewChatTeam: Team | null = null
let mockNewChat = false
let mockNewChatParams = new URLSearchParams()
let mockUserId = 1
let mockTaskType: TaskType = 'chat'
let mockRecentTeamIds: number[] = []
let mockRecentTeamsLoading = false
let mockEarlyDefaultTeam: Team | null = null
let mockUseStatefulSelection = false
let mockAutoSentTeamIds: Array<number | null> = []
const mockHandleTeamChange = jest.fn()
const mockFindDefaultTeam = (teams: Team[]) =>
  teams.find(team => team.default_for_modes?.includes(mockTaskType)) ?? null

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: mockUserId } }),
}))

jest.mock('@/features/tasks/hooks/useRecentTaskTeams', () => ({
  useRecentTaskTeams: (_mode: string, enabled: boolean) => ({
    recentTeamIds: enabled ? mockRecentTeamIds : [],
    isLoading: enabled && mockRecentTeamsLoading,
  }),
}))

jest.mock('@/features/tasks/hooks/useDefaultTeam', () => ({
  useDefaultTeam: (_mode: string, enabled: boolean) => (enabled ? mockEarlyDefaultTeam : null),
}))
let mockChatAreaSelectedModel: Record<string, unknown> | null = null
let mockChatAreaAttachments: Array<Record<string, unknown>> = []
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
  useSearchParams: () => (mockNewChat ? mockNewChatParams : new URLSearchParams('taskId=42')),
  useRouter: () => mockRouter,
  usePathname: () => '/chat',
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ isConnected: true }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    selectedDeviceId: null,
    setSelectedDeviceId: mockSetSelectedDeviceId,
  }),
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

jest.mock('@/features/tasks/hooks/useChatStatusIndicator', () => ({
  useChatStatusIndicator: () => ({
    enabled: false,
    display: null,
    currentTaskId: 42,
    isCompacting: false,
  }),
}))

jest.mock('@/features/tasks/components/chat/useChatAreaState', () => ({
  useChatAreaState: () => {
    const { useState, useCallback } = jest.requireActual<typeof import('react')>('react')
    const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
    const handleTeamChange = useCallback((team: Team | null) => {
      mockHandleTeamChange(team)
      setSelectedTeam(team)
    }, [])
    return {
      selectedTeam: mockUseStatefulSelection
        ? selectedTeam
        : mockNewChat
          ? mockNewChatTeam
          : mockChatAreaTeam,
      handleTeamChange: mockUseStatefulSelection ? handleTeamChange : mockHandleTeamChange,
      findDefaultTeamForMode: mockFindDefaultTeam,
      defaultTeam: null,
      restoreDefaultTeam: jest.fn(),
      isUsingDefaultTeam: false,
      selectedModel: mockChatAreaSelectedModel,
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
      attachmentState: {
        attachments: mockChatAreaAttachments,
        uploadingFiles: new Map(),
        errors: new Map(),
      },
      resetAttachment: jest.fn(),
      isAttachmentReadyToSend: true,
      shouldHideToolbarStatus: false,
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
    }
  },
}))

jest.mock('@/features/tasks/components/chat/useChatStreamHandlers', () => ({
  useChatStreamHandlers: ({ selectedTeam }: { selectedTeam: Team | null }) => ({
    pendingTaskId: null,
    isStreaming: false,
    isStopping: false,
    hasPendingUserMessage: false,
    handleSendMessage: mockUseStatefulSelection
      ? async (...args: unknown[]) => {
          mockAutoSentTeamIds.push(selectedTeam?.id ?? null)
          await mockHandleSendMessage(...args)
        }
      : mockHandleSendMessage,
    handleSendMessageWithModel: jest.fn(),
    handleRetry: jest.fn(),
    handleCancelTask: jest.fn(),
    stopStream: jest.fn(),
    resetStreamingState: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    selectedTaskDetail: mockNewChat ? null : mockSelectedTaskDetail,
    selectedTask: mockNewChat ? null : mockSelectedTaskDetail,
    selectTask: jest.fn(),
    accessDenied: false,
    taskState: {
      taskId: mockNewChat ? undefined : mockSelectedTaskDetail.id,
      messages: mockTaskMessages,
      runtime: { taskStatus: undefined },
    },
  }),
  useOptionalTaskSession: () => ({
    sendMessage: mockSendMessage,
  }),
}))

jest.mock('@/features/projects/contexts/projectContext', () => ({
  useProjectContext: () => ({
    projects: [],
    projectTaskIds: new Set(),
    isWorkspaceEnabled: false,
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
  QuickAccessCards: ({ onTeamSelect }: { onTeamSelect: (team: Team) => void }) => (
    <button data-testid="quick-access-cards" onClick={() => onTeamSelect(mockSelectedTeam)}>
      Select agent
    </button>
  ),
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
  getFileExtension: (filename: string) => filename.slice(filename.lastIndexOf('.')),
  isAudioExtension: (extension: string) => ['.mp3', '.m4a'].includes(extension),
  isImageExtension: (extension: string) => ['.jpg', '.jpeg', '.png', '.webp'].includes(extension),
  isVideoExtension: (extension: string) => ['.mp4', '.mov'].includes(extension),
  formatsToAcceptString: jest.fn(() => 'image/*'),
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
  QueryParamAutoSend: jest.requireActual('@/features/tasks/components/params/QueryParamAutoSend')
    .default,
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
    mockChatAreaTeam = mockSelectedTeam
    mockNewChat = false
    mockNewChatParams = new URLSearchParams()
    mockUserId = 1
    mockTaskType = 'chat'
    mockRecentTeamIds = []
    mockRecentTeamsLoading = false
    mockEarlyDefaultTeam = null
    mockUseStatefulSelection = false
    mockHandleTeamChange.mockReset()
    mockChatAreaSelectedModel = null
    mockChatAreaAttachments = []
    ;(mockSelectedTeam.bots[0] as { contextPassing: string }).contextPassing = 'previous_bot'
    mockSendMessage.mockResolvedValue(42)
    setCompletedPipelineMessages()
  })

  it('keeps the input inside the chat pane in split view', () => {
    render(
      <ChatArea teams={[mockSelectedTeam]} isTeamsLoading={false} taskType="chat" isSplitViewOpen />
    )

    const splitInput = screen.getByTestId('chat-split-input')
    const inputSpacing = splitInput.firstElementChild?.firstElementChild

    expect(splitInput).toBeInTheDocument()
    expect(inputSpacing).toHaveClass('pb-3', 'pt-[41px]')
    expect(screen.queryByTestId('chat-floating-input')).not.toBeInTheDocument()
  })

  it('does not show a chat-model video warning for a mode-spec video workflow', () => {
    mockChatAreaTeam = {
      ...mockSelectedTeam,
      mode_spec: {
        allowedModelCategories: ['video'],
      },
    } as unknown as Team
    mockChatAreaSelectedModel = {
      name: 'planner-llm',
      config: {
        modelCapabilities: {
          supportsVideo: false,
        },
      },
    }
    mockChatAreaAttachments = [
      {
        id: 100,
        mime_type: 'video/mp4',
        file_extension: '.mp4',
      },
    ]

    render(<ChatArea teams={[mockChatAreaTeam]} isTeamsLoading={false} taskType="chat" />)

    expect(mockToast).not.toHaveBeenCalled()
  })

  it('keeps the metadata-only warning for ordinary chat video attachments', async () => {
    mockChatAreaSelectedModel = {
      name: 'planner-llm',
      config: {
        modelCapabilities: {
          supportsVideo: false,
        },
      },
    }
    mockChatAreaAttachments = [
      {
        id: 100,
        mime_type: 'video/mp4',
        file_extension: '.mp4',
      },
    ]

    render(<ChatArea teams={[mockSelectedTeam]} isTeamsLoading={false} taskType="chat" />)

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1))
  })

  it('consumes an Artifact prompt once through the normal send handler', async () => {
    const request = {
      requestId: 'request-1',
      message: '解释过滤条件',
      artifactContext: {
        artifact_id: 'artifact-1',
        node_id: 'node-2',
      },
    }
    const onConsumed = jest.fn()
    const { rerender } = render(
      <ChatArea
        teams={[mockSelectedTeam]}
        isTeamsLoading={false}
        taskType="knowledge"
        externalPromptRequest={request}
        onExternalPromptConsumed={onConsumed}
      />
    )

    await waitFor(() =>
      expect(mockHandleSendMessage).toHaveBeenCalledWith('解释过滤条件', {
        artifactContext: {
          artifact_id: 'artifact-1',
          node_id: 'node-2',
        },
      })
    )
    rerender(
      <ChatArea
        teams={[mockSelectedTeam]}
        isTeamsLoading={false}
        taskType="knowledge"
        externalPromptRequest={request}
        onExternalPromptConsumed={onConsumed}
      />
    )

    expect(mockHandleSendMessage).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onConsumed).toHaveBeenCalledWith('request-1'))
  })

  it('preserves Artifact context after cancelling a pending interactive form', async () => {
    mockTaskMessages = new Map([
      [
        'ai-form',
        {
          id: 'ai-form',
          type: 'ai',
          content: '',
          subtaskId: 20,
          result: {
            blocks: [
              {
                id: 'tool-1',
                type: 'tool',
                tool_name: 'interactive_form_question',
                tool_use_id: 'tool-1',
                render_payload: {
                  type: 'interactive_form_question',
                  task_id: 42,
                  subtask_id: 20,
                  questions: [{ id: 'q1', question: 'Question?' }],
                },
              },
            ],
          },
        },
      ],
    ])
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    render(
      <ChatArea
        teams={[mockSelectedTeam]}
        isTeamsLoading={false}
        taskType="knowledge"
        externalPromptRequest={{
          requestId: 'request-with-form',
          message: '解释过滤条件',
          artifactContext: {
            artifact_id: 'artifact-1',
            node_id: 'node-2',
          },
        }}
      />
    )

    await user.click(await screen.findByText('pending_form_confirm.confirm'))

    await waitFor(() =>
      expect(mockHandleSendMessage).toHaveBeenCalledWith('解释过滤条件', {
        artifactContext: {
          artifact_id: 'artifact-1',
          node_id: 'node-2',
        },
        interactiveFormAnswer: expect.objectContaining({
          tool_use_id: 'tool-1',
          status: 'cancelled',
        }),
      })
    )
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
    expect(request.message).toBe('Previous stage output:\nBuild this feature')
    expect(request.message).not.toContain('[User]\nOriginal request')
    expect(options).toMatchObject({
      pendingUserMessage: 'Previous stage output:\nBuild this feature',
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

  it('opens the picker without default selections and sends manually checked context', async () => {
    ;(mockSelectedTeam.bots[0] as { contextPassing: string }).contextPassing = 'none'
    mockTaskMessages = new Map([
      [
        'user-1',
        {
          id: 'user-1',
          type: 'user',
          status: 'completed',
          content: 'Original request',
          timestamp: 1,
          contexts: [],
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
          contexts: [],
        },
      ],
    ])
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    render(<ChatArea teams={[mockSelectedTeam]} isTeamsLoading={false} taskType="chat" />)

    await user.click(await screen.findByTestId('pipeline-next-step-button'))

    const confirmButton = screen.getByTestId('pipeline-next-step-confirm-button')
    expect(confirmButton).toBeDisabled()

    await user.click(screen.getByTestId('pipeline-next-step-text-checkbox-ai_response:ai-1'))
    expect(confirmButton).toBeEnabled()
    await user.click(confirmButton)

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1))

    const [request] = mockSendMessage.mock.calls[0]
    expect(request.message).toBe('Previous stage output:\nBuild this feature')
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

describe('ChatArea selection while the catalog loads', () => {
  const defaultTeam = {
    ...mockSelectedTeam,
    id: 8,
    bind_mode: ['chat'],
    default_for_modes: ['chat'],
  } as Team

  beforeEach(() => {
    mockNewChat = true
    mockNewChatParams = new URLSearchParams()
    mockUserId = 1
    mockTaskType = 'chat'
    mockRecentTeamIds = []
    mockRecentTeamsLoading = false
    mockNewChatTeam = null
    mockEarlyDefaultTeam = null
    mockUseStatefulSelection = false
    mockTaskMessages = new Map()
    mockHandleTeamChange.mockReset().mockImplementation((team: Team | null) => {
      mockNewChatTeam = team
    })
    mockHandleSendMessage.mockReset().mockResolvedValue(undefined)
  })

  it.each(['present', 'removed', 'empty', 'failed'] as const)(
    'preserves an early manual selection and reconciles a %s catalog',
    outcome => {
      const { rerender } = render(<ChatArea teams={[]} isTeamsLoading taskType="chat" />)
      fireEvent.click(screen.getByTestId('quick-access-cards'))
      expect(mockNewChatTeam?.id).toBe(7)
      mockHandleTeamChange.mockClear()

      // The default arrives after the user has already chosen another agent.
      mockEarlyDefaultTeam = defaultTeam
      rerender(<ChatArea teams={[]} isTeamsLoading taskType="chat" />)
      expect(mockHandleTeamChange).not.toHaveBeenCalled()

      const catalog =
        outcome === 'present'
          ? [defaultTeam, { ...mockSelectedTeam, bind_mode: ['chat'] } as Team]
          : outcome === 'empty'
            ? []
            : [defaultTeam]
      rerender(
        <ChatArea
          teams={catalog}
          isTeamsLoading={false}
          loadError={outcome === 'failed' ? new Error('Unavailable') : null}
          taskType="chat"
        />
      )
      expect(mockNewChatTeam?.id ?? null).toBe(
        outcome === 'removed' ? 8 : outcome === 'empty' ? null : 7
      )
    }
  )

  it('restores the latest available same-mode agent before the configured default', () => {
    const recentTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    const incompatibleTeam = { ...mockSelectedTeam, id: 9, bind_mode: ['code'] } as Team
    mockRecentTeamIds = [999, incompatibleTeam.id, recentTeam.id]

    render(
      <ChatArea
        teams={[defaultTeam, incompatibleTeam, recentTeam]}
        isTeamsLoading={false}
        taskType="chat"
        teamModeFilter="all"
      />
    )

    expect(mockNewChatTeam?.id).toBe(recentTeam.id)
  })

  it('keeps agent A after creating another task and restores A in a fresh tab', () => {
    const agentA = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    const catalog = [defaultTeam, agentA]
    mockNewChat = false
    mockRecentTeamIds = [defaultTeam.id]
    const currentTab = render(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockHandleTeamChange).toHaveBeenLastCalledWith(agentA)

    mockNewChat = true
    mockNewChatTeam = agentA
    currentTab.rerender(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam.id).toBe(agentA.id)
    currentTab.unmount()
    mockNewChatTeam = null
    mockRecentTeamIds = [agentA.id]

    render(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockHandleTeamChange).toHaveBeenLastCalledWith(agentA)
  })

  it('uses the configured default, then the first candidate when history is empty', () => {
    const firstTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    const first = render(
      <ChatArea teams={[firstTeam, defaultTeam]} isTeamsLoading={false} taskType="chat" />
    )
    expect(mockNewChatTeam?.id).toBe(defaultTeam.id)
    first.unmount()
    mockNewChatTeam = null

    render(<ChatArea teams={[firstTeam]} isTeamsLoading={false} taskType="chat" />)
    expect(mockHandleTeamChange).toHaveBeenLastCalledWith(firstTeam)
  })

  it('replaces a provisional default after catalog and history finish loading', () => {
    const recentTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    mockEarlyDefaultTeam = defaultTeam
    mockRecentTeamsLoading = true
    const { rerender } = render(<ChatArea teams={[]} isTeamsLoading taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(defaultTeam.id)

    rerender(<ChatArea teams={[defaultTeam, recentTeam]} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(defaultTeam.id)
    mockRecentTeamIds = [recentTeam.id]
    mockRecentTeamsLoading = false
    rerender(<ChatArea teams={[defaultTeam, recentTeam]} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(recentTeam.id)
  })

  it('preserves a manual choice when history arrives later', () => {
    const manualTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    const catalog = [defaultTeam, manualTeam]
    mockRecentTeamsLoading = true
    const { rerender } = render(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    fireEvent.click(screen.getByTestId('quick-access-cards'))
    expect(mockNewChatTeam?.id).toBe(manualTeam.id)
    mockHandleTeamChange.mockClear()

    mockRecentTeamIds = [defaultTeam.id]
    mockRecentTeamsLoading = false
    rerender(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockHandleTeamChange).not.toHaveBeenCalled()
    expect(mockNewChatTeam?.id).toBe(manualTeam.id)
  })

  it('honors an explicit URL agent before history and keeps a later manual choice', () => {
    const manualTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    const catalog = [defaultTeam, manualTeam]
    mockNewChatParams = new URLSearchParams(`teamId=${defaultTeam.id}`)
    mockRecentTeamIds = [manualTeam.id]
    const { rerender } = render(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(defaultTeam.id)
    fireEvent.click(screen.getByTestId('quick-access-cards'))
    mockHandleTeamChange.mockClear()

    rerender(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockHandleTeamChange).not.toHaveBeenCalled()
    expect(mockNewChatTeam?.id).toBe(manualTeam.id)
  })

  it('keeps an explicitly supplied new-task agent', () => {
    mockRecentTeamIds = [defaultTeam.id]
    render(
      <ChatArea
        teams={[defaultTeam, mockSelectedTeam]}
        selectedTeamForNewTask={mockSelectedTeam}
        isTeamsLoading={false}
        taskType="chat"
      />
    )
    expect(mockHandleTeamChange).not.toHaveBeenCalled()
  })

  it('restores each mode independently when switching without remounting', () => {
    const chatTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    const codeTeam = { ...mockSelectedTeam, id: 9, bind_mode: ['code'] } as Team
    const catalog = [defaultTeam, chatTeam, codeTeam]
    mockRecentTeamIds = [chatTeam.id]
    const { rerender } = render(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(chatTeam.id)

    mockTaskType = 'code'
    mockRecentTeamIds = [codeTeam.id]
    rerender(<ChatArea teams={catalog} isTeamsLoading={false} taskType="code" />)
    expect(mockNewChatTeam?.id).toBe(codeTeam.id)

    mockTaskType = 'chat'
    mockRecentTeamIds = [chatTeam.id]
    rerender(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(chatTeam.id)
  })

  it('restores the signed-in users own history after an account switch', () => {
    const recentTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
    const catalog = [defaultTeam, recentTeam]
    mockRecentTeamIds = [recentTeam.id]
    const { rerender } = render(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(recentTeam.id)

    mockUserId = 2
    mockRecentTeamIds = [defaultTeam.id]
    rerender(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
    expect(mockNewChatTeam?.id).toBe(defaultTeam.id)
  })

  it.each([true, false])(
    'waits for delayed history before auto-sending once with a configured default: %s',
    async hasConfiguredDefault => {
      jest.useFakeTimers()
      mockUseStatefulSelection = true
      mockNewChatParams = new URLSearchParams('q=hello&autosend=true')
      mockRecentTeamsLoading = true
      const recentTeam = { ...mockSelectedTeam, bind_mode: ['chat'] } as Team
      const catalog = hasConfiguredDefault ? [defaultTeam, recentTeam] : [recentTeam]
      mockAutoSentTeamIds = []

      try {
        const view = render(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
        await act(async () => {
          jest.advanceTimersByTime(400)
        })
        expect(mockHandleSendMessage).not.toHaveBeenCalled()

        mockRecentTeamIds = [recentTeam.id]
        mockRecentTeamsLoading = false
        view.rerender(<ChatArea teams={catalog} isTeamsLoading={false} taskType="chat" />)
        await act(async () => {
          jest.advanceTimersByTime(400)
        })

        expect(mockAutoSentTeamIds).toEqual([recentTeam.id])
        expect(mockHandleSendMessage).toHaveBeenCalledWith('hello')
        await act(async () => {
          jest.advanceTimersByTime(1000)
        })
        expect(mockHandleSendMessage).toHaveBeenCalledTimes(1)
        view.unmount()
      } finally {
        jest.useRealTimers()
      }
    }
  )
})
