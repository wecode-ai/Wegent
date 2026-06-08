import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TaskDetail, Team } from '@/types/api'

import { ChatArea } from '@/features/tasks/components/chat'
import { userApis } from '@/apis/user'

const mockChatInputCard = jest.fn((_props: Record<string, unknown>) => (
  <div data-testid="chat-input-card" />
))
const mockAddExistingAttachment = jest.fn()
const mockHandleFileSelect = jest.fn()
const mockHandleAttachmentRemove = jest.fn()
const mockHandleTeamChange = jest.fn()
const mockSetSelectedDeviceId = jest.fn()

const defaultStreamHandlers = {
  pendingTaskId: null,
  isStreaming: false,
  canQueueMessage: false,
  queuedMessageCount: 0,
  queuedMessages: [] as Array<{
    id: string
    displayMessage: string
    status: 'queued' | 'sending' | 'failed'
    error?: string
  }>,
  cancelQueuedMessage: jest.fn(),
  isStopping: false,
  hasPendingUserMessage: false,
  handleSendMessage: jest.fn(),
  handleSendMessageWithModel: jest.fn(),
  handleRetry: jest.fn(),
  handleCancelTask: jest.fn(),
  stopStream: jest.fn(),
  resetStreamingState: jest.fn(),
}

let streamHandlersMock = { ...defaultStreamHandlers }
let selectedTaskDetailMock: TaskDetail | null = null
let mockTaskInputMessage = ''
const mockSetTaskInputMessage = jest.fn()

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/chat',
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    selectedDeviceId: 'device-1',
    setSelectedDeviceId: mockSetSelectedDeviceId,
  }),
}))

jest.mock('@/features/inbox', () => ({
  QueueMessageHandler: () => <div data-testid="queue-message-handler" />,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/tasks/components/chat/useChatAreaState', () => ({
  useChatAreaState: () => ({
    selectedTeam: null,
    handleTeamChange: mockHandleTeamChange,
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
    taskInputMessage: mockTaskInputMessage,
    setTaskInputMessage: mockSetTaskInputMessage,
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
    addExistingAttachment: mockAddExistingAttachment,
    handleFileSelect: mockHandleFileSelect,
    handleAttachmentRemove: mockHandleAttachmentRemove,
    setIsDragging: jest.fn(),
    isDragging: false,
    randomTip: 'tip',
    randomSlogan: 'slogan',
  }),
}))

jest.mock('@/features/tasks/components/chat/useChatStreamHandlers', () => ({
  useChatStreamHandlers: () => streamHandlersMock,
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    selectedTaskDetail: selectedTaskDetailMock,
    selectedTask: selectedTaskDetailMock,
    selectTask: jest.fn(),
    accessDenied: false,
    taskState: {
      taskId: selectedTaskDetailMock?.id,
      messages: new Map(),
      runtime: { taskStatus: selectedTaskDetailMock?.status },
    },
  }),
  useOptionalTaskSession: () => ({
    sendMessage: jest.fn(),
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
  '@/features/tasks/components/message/MessagesArea',
  () =>
    function MockMessagesArea() {
      return <div data-testid="messages-area" />
    }
)
jest.mock('@/features/tasks/components/chat/QuickAccessCards', () => ({
  QuickAccessCards: (props: {
    onTeamSelect: (team: Team) => void
    onPhraseSelect: (phrase: string) => void
    onPresetSelect?: (selection: unknown) => void
  }) => (
    <div data-testid="quick-access-cards">
      <button
        type="button"
        data-testid="quick-phrase-trigger"
        onClick={() => props.onPhraseSelect('quick phrase')}
      >
        Quick phrase
      </button>
      <button
        type="button"
        data-testid="quick-preset-trigger"
        onClick={() =>
          props.onPresetSelect?.({
            launcher: {
              key: 'system:create_ppt',
              type: 'system_function',
              title: 'Create PPT',
              team: { id: 12 },
              targetPage: 'chat',
              inputPresets: [],
            },
            preset: {
              id: 'roadmap',
              title: 'Roadmap',
              prompt: 'make roadmap',
              source_attachment_ids: [300],
            },
          })
        }
      >
        Quick preset
      </button>
      <button
        type="button"
        data-testid="quick-team-trigger"
        onClick={() =>
          props.onTeamSelect({
            id: 12,
            name: 'openai-advanced-claudecode-team',
            displayName: 'OpenAI Advanced ClaudeCode Team',
            description: '',
            bots: [
              {
                bot_id: 1,
                bot_prompt: '',
                bot: {
                  shell_type: 'ClaudeCode',
                  agent_config: {
                    protocol: 'openai',
                  },
                },
              },
            ],
            workflow: {},
            is_active: true,
            user_id: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            agent_type: 'claude',
          })
        }
      >
        Quick team
      </button>
    </div>
  ),
}))
jest.mock('@/features/tasks/components/chat/SloganDisplay', () => ({
  SloganDisplay: () => <div data-testid="slogan-display" />,
}))
jest.mock('@/features/tasks/components/input/ChatInputCard', () => ({
  ChatInputCard: (props: Record<string, unknown>) => mockChatInputCard(props),
}))
jest.mock(
  '@/features/tasks/components/chat/PipelineStageIndicator',
  () =>
    function MockPipelineStageIndicator() {
      return <div data-testid="pipeline-stage-indicator" />
    }
)
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
jest.mock('@/apis/user', () => ({
  userApis: {
    prepareQuickLaunchPreset: jest.fn(),
  },
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

describe('ChatArea queue message handler mounting', () => {
  beforeEach(() => {
    streamHandlersMock = { ...defaultStreamHandlers }
    selectedTaskDetailMock = null
    mockTaskInputMessage = ''
    mockSetTaskInputMessage.mockClear()
    mockChatInputCard.mockClear()
    mockAddExistingAttachment.mockClear()
    mockHandleFileSelect.mockClear()
    mockHandleAttachmentRemove.mockClear()
    mockHandleTeamChange.mockClear()
    mockSetSelectedDeviceId.mockClear()
    ;(
      userApis as unknown as { prepareQuickLaunchPreset: jest.Mock }
    ).prepareQuickLaunchPreset.mockReset()
  })

  it('mounts QueueMessageHandler for chat mode', () => {
    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)
    expect(screen.getByTestId('queue-message-handler')).toBeInTheDocument()
  })

  it('mounts QueueMessageHandler for code mode', () => {
    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="code" showRepositorySelector />)
    expect(screen.getByTestId('queue-message-handler')).toBeInTheDocument()
  })

  it('mounts QueueMessageHandler for task mode', () => {
    render(
      <ChatArea teams={[]} isTeamsLoading={false} taskType="task" showRepositorySelector={false} />
    )
    expect(screen.getByTestId('queue-message-handler')).toBeInTheDocument()
  })

  it('passes queued send availability to ChatInputCard for a running task', () => {
    streamHandlersMock = {
      ...defaultStreamHandlers,
      isStreaming: true,
      canQueueMessage: true,
    }
    selectedTaskDetailMock = {
      id: 42,
      status: 'RUNNING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail

    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    expect(mockChatInputCard).toHaveBeenCalledWith(
      expect.objectContaining({ canQueueMessage: true, canSubmit: true, queuedMessages: [] })
    )
  })

  it('passes queued message cancellation to ChatInputCard', () => {
    const cancelQueuedMessage = jest.fn()
    const queuedMessages = [
      {
        id: '42:local-user-1',
        displayMessage: 'next question',
        status: 'queued' as const,
      },
    ]
    streamHandlersMock = {
      ...defaultStreamHandlers,
      isStreaming: true,
      canQueueMessage: true,
      queuedMessages,
      cancelQueuedMessage,
    }
    selectedTaskDetailMock = {
      id: 42,
      status: 'RUNNING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail

    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    expect(mockChatInputCard).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedMessages,
        onCancelQueuedMessage: cancelQueuedMessage,
      })
    )
  })

  it('keeps submit disabled while streaming when queueing is unavailable', () => {
    streamHandlersMock = {
      ...defaultStreamHandlers,
      isStreaming: true,
      canQueueMessage: false,
    }
    selectedTaskDetailMock = {
      id: 42,
      status: 'RUNNING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail

    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    expect(mockChatInputCard).toHaveBeenCalledWith(
      expect.objectContaining({ canQueueMessage: false, canSubmit: false })
    )
  })

  it('fills a quick phrase directly and requests focus at the end when input is empty', async () => {
    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    fireEvent.click(screen.getByTestId('quick-phrase-trigger'))

    expect(mockSetTaskInputMessage).toHaveBeenCalledWith('quick phrase')
    expect(screen.queryByText('quick_launch.overwrite_confirm_title')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mockChatInputCard).toHaveBeenLastCalledWith(
        expect.objectContaining({ focusInputAtEndSignal: 1 })
      )
    })
  })

  it('asks before overwriting existing input with a quick phrase', async () => {
    mockTaskInputMessage = 'existing input'

    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    fireEvent.click(screen.getByTestId('quick-phrase-trigger'))

    expect(mockSetTaskInputMessage).not.toHaveBeenCalledWith('quick phrase')
    expect(screen.getByText('quick_launch.overwrite_confirm_title')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('quick-phrase-overwrite-confirm'))

    expect(mockSetTaskInputMessage).toHaveBeenCalledWith('quick phrase')
    await waitFor(() => {
      expect(mockChatInputCard).toHaveBeenLastCalledWith(
        expect.objectContaining({ focusInputAtEndSignal: 1 })
      )
    })
  })

  it('prepares and displays quick launch preset attachments', async () => {
    ;(
      userApis as unknown as { prepareQuickLaunchPreset: jest.Mock }
    ).prepareQuickLaunchPreset.mockResolvedValue({
      function_id: 'create_ppt',
      preset_id: 'roadmap',
      attachments: [
        {
          id: 901,
          filename: 'roadmap-template.pdf',
          file_size: 2048,
          mime_type: 'application/pdf',
          status: 'ready',
          text_length: 120,
          error_message: null,
          error_code: null,
          subtask_id: null,
          file_extension: '.pdf',
          created_at: '2026-06-04T00:00:00Z',
        },
      ],
    })

    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    fireEvent.click(screen.getByTestId('quick-preset-trigger'))

    await waitFor(() => {
      expect(
        (userApis as unknown as { prepareQuickLaunchPreset: jest.Mock }).prepareQuickLaunchPreset
      ).toHaveBeenCalledWith({
        function_id: 'create_ppt',
        preset_id: 'roadmap',
      })
    })
    expect(mockAddExistingAttachment).toHaveBeenCalledWith({
      id: 901,
      filename: 'roadmap-template.pdf',
      file_size: 2048,
      mime_type: 'application/pdf',
      status: 'ready',
      text_length: 120,
      error_message: null,
      error_code: null,
      subtask_id: null,
      file_extension: '.pdf',
      created_at: '2026-06-04T00:00:00Z',
    })
    expect(mockSetTaskInputMessage).toHaveBeenCalledWith('make roadmap')
  })

  it('leaves device mode when quick action selects a ClaudeCode team with non-Claude protocol', () => {
    render(
      <ChatArea teams={[]} isTeamsLoading={false} taskType="task" showRepositorySelector={false} />
    )

    fireEvent.click(screen.getByTestId('quick-team-trigger'))

    expect(mockSetSelectedDeviceId).toHaveBeenCalledWith(null)
    expect(mockHandleTeamChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12, agent_type: 'claude' })
    )
  })

  it('submits to the stream handler for queueing when a pending task is already streaming', async () => {
    const handleSendMessage = jest.fn().mockResolvedValue(undefined)
    streamHandlersMock = {
      ...defaultStreamHandlers,
      isStreaming: true,
      canQueueMessage: true,
      handleSendMessage,
    }
    selectedTaskDetailMock = {
      id: 42,
      status: 'PENDING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail

    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    const latestProps = mockChatInputCard.mock.calls.at(-1)?.[0] as {
      handleSendMessage: (message?: string) => Promise<void>
    }

    await act(async () => {
      await latestProps.handleSendMessage('follow up while streaming')
    })

    expect(handleSendMessage).toHaveBeenCalledWith('follow up while streaming', undefined)
  })

  it('keeps submit available for queueing while a pending user message is in state', () => {
    streamHandlersMock = {
      ...defaultStreamHandlers,
      isStreaming: true,
      canQueueMessage: true,
      hasPendingUserMessage: true,
    }
    selectedTaskDetailMock = {
      id: 42,
      status: 'RUNNING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail

    render(<ChatArea teams={[]} isTeamsLoading={false} taskType="chat" showRepositorySelector />)

    expect(mockChatInputCard).toHaveBeenCalledWith(
      expect.objectContaining({ canQueueMessage: true, canSubmit: true })
    )
  })
})
