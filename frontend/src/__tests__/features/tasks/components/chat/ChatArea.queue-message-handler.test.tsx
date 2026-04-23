import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { ChatArea } from '@/features/tasks/components/chat'

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn() }),
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
    selectedTaskDetail: null,
    setSelectedTask: jest.fn(),
    accessDenied: false,
  }),
}))

jest.mock('@/features/tasks/hooks/useTaskStateMachine', () => ({
  useTaskStateMachine: () => ({ state: { messages: new Map() } }),
}))

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
})
