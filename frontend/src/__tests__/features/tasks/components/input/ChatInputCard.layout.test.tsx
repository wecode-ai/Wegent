import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import {
  ChatInputCard,
  type ChatInputCardProps,
} from '@/features/tasks/components/input/ChatInputCard'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/tasks/components/input/ChatInput', () => ({
  __esModule: true,
  default: ({ compactSpacing }: { compactSpacing?: boolean }) => (
    <div data-testid="chat-input" data-compact-spacing={compactSpacing ? 'true' : 'false'} />
  ),
}))

jest.mock('@/features/tasks/components/input/InputBadgeDisplay', () => ({
  __esModule: true,
  default: () => <div data-testid="input-badge-display" />,
}))

jest.mock('@/features/tasks/components/params/ExternalApiParamsInput', () => ({
  __esModule: true,
  default: () => <div data-testid="external-api-params" />,
}))

jest.mock('@/features/tasks/components/selector/SelectedTeamBadge', () => ({
  SelectedTeamBadge: () => <div data-testid="selected-team-badge" />,
}))

jest.mock('@/features/tasks/components/input/ChatInputControls', () => ({
  __esModule: true,
  default: () => <div data-testid="chat-input-controls" />,
}))

jest.mock('@/features/tasks/components/input/DeviceSelectorTab', () => ({
  __esModule: true,
  default: () => <div data-testid="device-selector-tab" />,
}))

jest.mock('@/features/tasks/components/text-selection', () => ({
  QuoteCard: () => <div data-testid="quote-card" />,
}))

jest.mock('@/features/tasks/components/input/ConnectionStatusBanner', () => ({
  ConnectionStatusBanner: () => <div data-testid="connection-status-banner" />,
}))

const buildProps = (): ChatInputCardProps => ({
  taskInputMessage: '',
  setTaskInputMessage: jest.fn(),
  selectedTeam: null,
  teams: [],
  onTeamChange: jest.fn(),
  externalApiParams: {},
  onExternalApiParamsChange: jest.fn(),
  onAppModeChange: jest.fn(),
  onRestoreDefaultTeam: jest.fn(),
  isUsingDefaultTeam: true,
  taskType: 'code',
  autoFocus: false,
  knowledgeBaseId: undefined,
  tipText: null,
  isGroupChat: false,
  isDragging: false,
  onDragEnter: jest.fn(),
  onDragLeave: jest.fn(),
  onDragOver: jest.fn(),
  onDrop: jest.fn(),
  onPasteFile: jest.fn(),
  canSubmit: true,
  handleSendMessage: jest.fn(),
  inputControlsRef: undefined,
  hasNoTeams: false,
  disabledReason: undefined,
  hideSelectors: false,
  onEditTeam: undefined,
  selectedModel: null,
  setSelectedModel: jest.fn(),
  forceOverride: false,
  setForceOverride: jest.fn(),
  teamId: undefined,
  taskId: undefined,
  showRepositorySelector: true,
  selectedRepo: null,
  setSelectedRepo: jest.fn(),
  selectedBranch: null,
  setSelectedBranch: jest.fn(),
  selectedTaskDetail: null,
  effectiveRequiresWorkspace: true,
  onRequiresWorkspaceChange: jest.fn(),
  enableDeepThinking: false,
  setEnableDeepThinking: jest.fn(),
  enableClarification: false,
  setEnableClarification: jest.fn(),
  enableCorrectionMode: false,
  correctionModelName: null,
  onCorrectionModeToggle: jest.fn(),
  selectedContexts: [
    {
      id: 101,
      name: '# feat(inbox): add direct agent mode',
      type: 'queue_message',
      senderName: 'admin',
      note: '# feat(inbox): add direct agent mode',
      contentPreview: '来自 admin 的 1 条消息',
      fullContent: '来自 admin 的 1 条消息',
      messageCount: 1,
      sourceTaskId: 11,
    },
  ],
  setSelectedContexts: jest.fn(),
  attachmentState: {
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  },
  onFileSelect: jest.fn(),
  onAttachmentRemove: jest.fn(),
  isLoading: false,
  isStreaming: false,
  isStopping: false,
  hasMessages: false,
  shouldCollapseSelectors: false,
  shouldHideQuotaUsage: false,
  shouldHideChatInput: false,
  isModelSelectionRequired: false,
  isAttachmentReadyToSend: true,
  isSubtaskStreaming: false,
  onStopStream: jest.fn(),
  onSendMessage: jest.fn(),
  availableSkills: [],
  teamSkillNames: [],
  preloadedSkillNames: [],
  selectedSkillNames: [],
  onToggleSkill: jest.fn(),
  videoModels: [],
  selectedVideoModel: null,
  onVideoModelChange: jest.fn(),
  isVideoModelsLoading: false,
  selectedResolution: '1080p',
  onResolutionChange: jest.fn(),
  availableResolutions: ['1080p'],
  selectedRatio: '16:9',
  onRatioChange: jest.fn(),
  availableRatios: ['16:9'],
  selectedDuration: 5,
  onDurationChange: jest.fn(),
  availableDurations: [5],
  selectedImageModel: null,
  onImageModelChange: jest.fn(),
  isImageModelsLoading: false,
  selectedImageSize: '1024x1024',
  onImageSizeChange: jest.fn(),
  onGenerateModeChange: jest.fn(),
})

describe('ChatInputCard layout', () => {
  it('keeps the badge area attached to the input content instead of distributing vertical gaps', () => {
    render(<ChatInputCard {...buildProps()} />)

    const chatInput = screen.getByTestId('chat-input')
    const chatInputWrapper = chatInput.parentElement
    const controlsWrapper = screen.getByTestId('chat-input-controls').parentElement
    const cardRoot = controlsWrapper?.parentElement

    expect(cardRoot).toHaveClass('justify-start')
    expect(cardRoot).not.toHaveClass('justify-between')
    expect(controlsWrapper).toHaveClass('mt-auto')
    expect(chatInput).toHaveAttribute('data-compact-spacing', 'true')
    expect(chatInputWrapper).toHaveClass('pt-1.5')
    expect(chatInputWrapper).not.toHaveClass('pt-3')
  })
})
