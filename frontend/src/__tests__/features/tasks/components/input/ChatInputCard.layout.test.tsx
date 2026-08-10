import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  ChatInputCard,
  type ChatInputCardProps,
} from '@/features/tasks/components/input/ChatInputCard'

const mockChatInputControls = jest.fn((_props: Record<string, unknown>) => (
  <div data-testid="chat-input-controls" />
))
const mockSelectedTeamBadge = jest.fn((_props: Record<string, unknown>) => (
  <div data-testid="selected-team-badge" />
))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/tasks/components/input/ChatInput', () => ({
  __esModule: true,
  default: ({ compactSpacing, badge }: { compactSpacing?: boolean; badge?: React.ReactNode }) => (
    <div data-testid="chat-input" data-compact-spacing={compactSpacing ? 'true' : 'false'}>
      {badge}
    </div>
  ),
}))

jest.mock('@/features/tasks/components/input/InputBadgeDisplay', () => ({
  __esModule: true,
  default: () => <div data-testid="input-badge-display" />,
  useAuthenticatedImageInline: () => ({
    blobUrl: 'blob:test-image',
    isLoading: false,
    error: false,
  }),
}))

jest.mock('@/features/tasks/components/params/ExternalApiParamsInput', () => ({
  __esModule: true,
  default: () => <div data-testid="external-api-params" />,
}))

jest.mock('@/features/tasks/components/selector/SelectedTeamBadge', () => ({
  SelectedTeamBadge: (props: Record<string, unknown>) => mockSelectedTeamBadge(props),
}))

jest.mock('@/features/tasks/components/input/ChatInputControls', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockChatInputControls(props),
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
  isStreaming: false,
  isStopping: false,
  hasMessages: false,
  shouldCollapseSelectors: false,
  shouldHideToolbarStatus: false,
  shouldHideChatInput: false,
  isModelSelectionRequired: false,
  isAttachmentReadyToSend: true,
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
  beforeEach(() => {
    mockChatInputControls.mockClear()
    mockSelectedTeamBadge.mockClear()
  })

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

  it('forwards queue and guidance state to input controls', () => {
    render(
      <ChatInputCard {...buildProps()} canQueueMessage canSendGuidance onSendGuidance={jest.fn()} />
    )

    expect(mockChatInputControls).toHaveBeenCalledWith(
      expect.objectContaining({
        canQueueMessage: true,
        canSendGuidance: true,
        onSendGuidance: expect.any(Function),
      })
    )
  })

  it('uses the clearable team badge in image generation mode', () => {
    const onRestoreDefaultTeam = jest.fn()
    const imageTeam: NonNullable<ChatInputCardProps['selectedTeam']> = {
      id: 2,
      name: 'image-agent',
      namespace: 'default',
      description: '',
      bots: [],
      workflow: { mode: 'solo' },
      is_active: true,
      user_id: 123,
      created_at: '2026-08-07T00:00:00Z',
      updated_at: '2026-08-07T00:00:00Z',
      bind_mode: ['image'],
    }

    render(
      <ChatInputCard
        {...buildProps()}
        taskType="image"
        selectedTeam={imageTeam}
        teams={[imageTeam]}
        isUsingDefaultTeam={false}
        onRestoreDefaultTeam={onRestoreDefaultTeam}
      />
    )

    expect(screen.getByTestId('selected-team-badge')).toBeInTheDocument()
    expect(mockSelectedTeamBadge.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        team: imageTeam,
        showClearButton: true,
        onClear: onRestoreDefaultTeam,
      })
    )
  })

  it('does not allow clearing the selected team after the conversation starts', () => {
    const imageTeam: NonNullable<ChatInputCardProps['selectedTeam']> = {
      id: 2,
      name: 'image-agent',
      namespace: 'default',
      description: '',
      bots: [],
      workflow: { mode: 'solo' },
      is_active: true,
      user_id: 123,
      created_at: '2026-08-07T00:00:00Z',
      updated_at: '2026-08-07T00:00:00Z',
      bind_mode: ['image'],
    }

    render(
      <ChatInputCard
        {...buildProps()}
        taskType="image"
        selectedTeam={imageTeam}
        teams={[imageTeam]}
        isUsingDefaultTeam={false}
        hasMessages
      />
    )

    expect(mockSelectedTeamBadge.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        team: imageTeam,
        showClearButton: false,
      })
    )
  })

  it('renders queued messages above the chat input', () => {
    render(
      <ChatInputCard
        {...buildProps()}
        queuedMessages={[
          {
            id: '42:local-user-1',
            displayMessage: 'next question',
            status: 'queued',
          },
        ]}
      />
    )

    const queuedList = screen.getByTestId('queued-message-list')
    const card = screen.getByTestId('chat-input-card')
    const chatInput = screen.getByTestId('chat-input')

    expect(queuedList).toHaveTextContent('next question')
    expect(queuedList).toHaveTextContent('messages.status_queued')
    expect(queuedList.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(card).toContainElement(chatInput)
    expect(card).not.toContainElement(queuedList)
  })

  it('cancels a queued message from the queue preview', () => {
    const onCancelQueuedMessage = jest.fn()

    render(
      <ChatInputCard
        {...buildProps()}
        onCancelQueuedMessage={onCancelQueuedMessage}
        queuedMessages={[
          {
            id: '42:local-user-1',
            displayMessage: 'next question',
            status: 'queued',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('cancel-queued-message-button'))

    expect(onCancelQueuedMessage).toHaveBeenCalledWith('42:local-user-1')
  })

  it('moves a queued message back to the chat input for editing', () => {
    const onEditQueuedMessage = jest.fn()

    render(
      <ChatInputCard
        {...buildProps()}
        onEditQueuedMessage={onEditQueuedMessage}
        queuedMessages={[
          {
            id: '42:local-user-1',
            displayMessage: 'next question',
            status: 'queued',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('edit-queued-message-button'))

    expect(onEditQueuedMessage).toHaveBeenCalledWith('42:local-user-1')
    expect(screen.queryByTestId('prompt-edit-textarea')).not.toBeInTheDocument()
  })

  it('does not allow cancelling a queued message that is already sending', () => {
    render(
      <ChatInputCard
        {...buildProps()}
        onCancelQueuedMessage={jest.fn()}
        queuedMessages={[
          {
            id: '42:local-user-1',
            displayMessage: 'next question',
            status: 'sending',
          },
        ]}
      />
    )

    expect(screen.getByTestId('queued-message-list')).toHaveTextContent('messages.status_sending')
    expect(screen.queryByTestId('cancel-queued-message-button')).not.toBeInTheDocument()
  })

  it('renders pending and expired guidance cards', () => {
    const onCancelGuidance = jest.fn()
    const onSendExpiredGuidanceAsMessage = jest.fn()

    render(
      <ChatInputCard
        {...buildProps()}
        guidanceMessages={[
          {
            id: 'guidance-1',
            displayMessage: 'focus on risks',
            status: 'pending',
          },
        ]}
        expiredGuidanceMessages={[
          {
            id: 'guidance-2',
            displayMessage: 'add details',
            status: 'expired',
          },
        ]}
        onCancelGuidance={onCancelGuidance}
        onSendExpiredGuidanceAsMessage={onSendExpiredGuidanceAsMessage}
      />
    )

    expect(screen.getByTestId('pending-guidance-card')).toHaveTextContent('focus on risks')
    expect(screen.getByTestId('expired-guidance-card')).toHaveTextContent('add details')

    fireEvent.click(screen.getByTestId('cancel-guidance-button'))
    fireEvent.click(screen.getByTestId('send-expired-guidance-as-message-button'))

    expect(onCancelGuidance).toHaveBeenCalledWith('guidance-1')
    expect(onSendExpiredGuidanceAsMessage).toHaveBeenCalledWith('guidance-2')
  })

  it('moves a guidance message back to the chat input for editing', () => {
    const onEditGuidanceMessage = jest.fn()

    render(
      <ChatInputCard
        {...buildProps()}
        guidanceMessages={[
          {
            id: 'guidance-1',
            displayMessage: 'focus on risks',
            status: 'queued',
          },
        ]}
        onEditGuidanceMessage={onEditGuidanceMessage}
      />
    )

    fireEvent.click(screen.getByTestId('edit-guidance-message-button'))

    expect(onEditGuidanceMessage).toHaveBeenCalledWith('guidance-1')
    expect(screen.queryByTestId('prompt-edit-textarea')).not.toBeInTheDocument()
  })

  it('renders ordered first and last frame upload slots', () => {
    const onFileSelect = jest.fn()
    const { rerender } = render(
      <ChatInputCard
        {...buildProps()}
        taskType="video"
        selectedVideoGenerationMode="first_last_frame"
        materialAccept="image/jpeg,image/png"
        onFileSelect={onFileSelect}
      />
    )

    expect(screen.getByTestId('first-last-frame-uploader')).toBeInTheDocument()
    expect(screen.getByTestId('first-last-frame-file-input')).toHaveAttribute(
      'accept',
      'image/jpeg,image/png'
    )
    expect(screen.getByTestId('first-frame-upload')).toBeEnabled()
    expect(screen.getByTestId('last-frame-upload')).toBeDisabled()

    rerender(
      <ChatInputCard
        {...buildProps()}
        taskType="video"
        selectedVideoGenerationMode="first_last_frame"
        materialAccept="image/jpeg,image/png"
        onFileSelect={onFileSelect}
        attachmentState={{
          attachments: [
            {
              id: 1,
              filename: 'first.jpg',
              file_size: 10,
              mime_type: 'image/jpeg',
              status: 'ready',
              subtask_id: null,
              file_extension: '.jpg',
              created_at: new Date().toISOString(),
            },
          ],
          uploadingFiles: new Map(),
          errors: new Map(),
        }}
      />
    )

    expect(screen.getByTestId('first-frame-upload')).toHaveTextContent('video.first_frame')
    expect(screen.getByTestId('last-frame-upload')).toBeEnabled()
  })

  it('swaps the uploaded first and last frames', () => {
    const onSwapAttachments = jest.fn()
    render(
      <ChatInputCard
        {...buildProps()}
        taskType="video"
        selectedVideoGenerationMode="first_last_frame"
        onSwapAttachments={onSwapAttachments}
        attachmentState={{
          attachments: [
            {
              id: 1,
              filename: 'first.jpg',
              file_size: 10,
              mime_type: 'image/jpeg',
              status: 'ready',
              subtask_id: null,
              file_extension: '.jpg',
              created_at: new Date().toISOString(),
            },
            {
              id: 2,
              filename: 'last.jpg',
              file_size: 10,
              mime_type: 'image/jpeg',
              status: 'ready',
              subtask_id: null,
              file_extension: '.jpg',
              created_at: new Date().toISOString(),
            },
          ],
          uploadingFiles: new Map(),
          errors: new Map(),
        }}
      />
    )

    fireEvent.click(screen.getByTestId('swap-first-last-frames'))

    expect(onSwapAttachments).toHaveBeenCalledWith(1, 2)
  })

  it('keeps the last frame in its slot after the first frame is removed', () => {
    const firstFrame = {
      id: 1,
      filename: 'first.jpg',
      file_size: 10,
      mime_type: 'image/jpeg',
      status: 'ready' as const,
      subtask_id: null,
      file_extension: '.jpg',
      created_at: new Date().toISOString(),
    }
    const lastFrame = {
      ...firstFrame,
      id: 2,
      filename: 'last.jpg',
    }
    const { rerender } = render(
      <ChatInputCard
        {...buildProps()}
        taskType="video"
        selectedVideoGenerationMode="first_last_frame"
        attachmentState={{
          attachments: [firstFrame, lastFrame],
          uploadingFiles: new Map(),
          errors: new Map(),
        }}
      />
    )

    rerender(
      <ChatInputCard
        {...buildProps()}
        taskType="video"
        selectedVideoGenerationMode="first_last_frame"
        attachmentState={{
          attachments: [lastFrame],
          uploadingFiles: new Map(),
          errors: new Map(),
        }}
      />
    )

    expect(screen.getByTestId('first-frame-upload').tagName).toBe('BUTTON')
    expect(screen.getByTestId('last-frame-upload')).toHaveTextContent('video.last_frame')
    expect(screen.getByTestId('last-frame-upload').querySelector('img')).toBeInTheDocument()
  })
})
