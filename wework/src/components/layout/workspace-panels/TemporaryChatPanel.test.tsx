import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setComposerValue } from '@/test/composer'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToolBlocksDisplay } from '@/components/chat/blocks/ToolBlocksDisplay'

import { modelSelectionFromRuntimeHandle } from '@/features/workbench/runtimeContextUsage'
import type {
  Attachment,
  DeviceInfo,
  ModelOptions,
  ModelSelectionConfig,
  RuntimeContextUsage,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import type { RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'

import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'
import { TemporaryChatPanel } from './TemporaryChatPanel'

import * as runtimeModelSelection from '@/features/workbench/runtimeModelSelection'
import { clearWorkbenchWorkspaceLaunch } from '@/features/workbench/workspaceLaunchRequest'

const attachment: Attachment = {
  id: -1,
  filename: 'sidebar-image.png',
  file_extension: '.png',
  mime_type: 'image/png',
  size_bytes: 128,
  local_path: '/tmp/sidebar-image.png',
  local_preview_url: 'blob:sidebar-image',
}

const address: RuntimeTaskAddress = {
  deviceId: 'device-1',
  taskId: 'task-1',
  workspacePath: '/tmp/workspace',
}

const mocks = vi.hoisted(() => ({
  markRead: vi.fn(),
  windowFocused: true,
  focusListener: undefined as undefined | ((focused: boolean) => void),
  renderToolBlocks: false,
  inputHost: undefined as
    | undefined
    | {
        getError: () => undefined
        isDisabled: () => boolean
        isSubmitting: () => boolean
        getDraft: () => Record<string, string>
        setDraft: ReturnType<typeof vi.fn>
        submit: ReturnType<typeof vi.fn>
      },
  devices: [] as DeviceInfo[],
  readCatalog: vi.fn(),
  readTask: vi.fn(),
  mainListApps: vi.fn(),
  usageHandlers: [] as Array<{ onContextUsageUpdated?: (usage: RuntimeContextUsage) => void }>,
  resetAttachments: vi.fn(),
  busy: false,
  runtimeModels: [] as UnifiedModel[],
  continueInNewConversation: vi.fn(),
  setGlobalModel: vi.fn(),
  globalModelReady: true,
  busySendError: false,
  lifecycleOwnerEpoch: 0,
  interruptAndSendRuntimePaneMessage: vi.fn(async () => true),
  sendRuntimePaneMessage: vi.fn(async () => true),
  sendRuntimePaneGuidance: vi.fn(),
  createTask: vi.fn(),
  loadRuntimeTranscriptForPane: vi.fn(),
  loadTurnFileChangesDiff: vi.fn(),
  revertTurnFileChanges: vi.fn(),
  cancelRuntimePaneTask: vi.fn(async () => true),
  syncTranscript: vi.fn(),
  conversationMessages: [] as WorkbenchMessage[],
  conversationTurns: [] as RuntimeConversationTurn[],
  lifecycleSnapshot: null as {
    task?: { threadId?: string; modelSelection?: ModelSelectionConfig }
    unread?: boolean
    turn?: { id: string | null }
    derived: {
      isRunning: boolean
      isTurnActive: boolean
    }
  } | null,
  activeModelSelection: null as ModelSelectionConfig | null,
  taskSelectionResolved: null as boolean | null,
  isBootstrapping: false,
  runtimeWork: null as {
    projects: unknown[]
    chats: unknown[]
    totalTasks: number
  } | null,
  inputByScope: {} as Record<string, string>,
  setInputForScope: vi.fn(),
}))

vi.mock('@/desktop/windowFocus', () => ({
  isMainWindowFocused: () => mocks.windowFocused,
  subscribeMainWindowFocus: (listener: (focused: boolean) => void) => {
    mocks.focusListener = listener
    return () => {
      mocks.focusListener = undefined
    }
  },
}))

vi.mock('@/features/notifications/useRuntimeInteractionInputHost', () => ({
  useRuntimeInteractionInputHost: () => mocks.inputHost,
}))

vi.mock('@/components/chat/ScrollableMessageArea', () => ({
  ScrollableMessageArea: ({
    messages,
    messageTarget,
    hideRequestUserInputBlocks,
  }: {
    messages: WorkbenchMessage[]
    messageTarget?: { messageId: string }
    hideRequestUserInputBlocks?: boolean
  }) => (
    <div data-testid="mock-message-list" data-target-message={messageTarget?.messageId}>
      {messages.map(message => (
        <span key={message.id}>{message.content}</span>
      ))}
      {mocks.renderToolBlocks &&
        messages.map(message => (
          <ToolBlocksDisplay
            key={message.id}
            blocks={message.blocks ?? []}
            isStreaming
            hideRequestUserInputBlocks={hideRequestUserInputBlocks}
          />
        ))}
    </div>
  ),
}))

vi.mock('@/components/layout/BufferedChatInput', () => ({
  BufferedChatInput: ({
    onSubmit,
    disabled,
    submitDisabled,
    projectChat,
  }: {
    onSubmit: (value: string) => Promise<boolean>
    disabled?: boolean
    submitDisabled?: boolean
    projectChat?: { isModelSelectionReady?: boolean }
  }) => (
    <button
      data-testid="mock-send"
      disabled={disabled || submitDisabled || projectChat?.isModelSelectionReady === false}
      onClick={() => void onSubmit('发送附件')}
    >
      发送
    </button>
  ),
}))

vi.mock('@/features/workbench/useWorkbench', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/workbench/useWorkbench')>()),
  useWorkbenchPaneContext: () => ({
    services: {
      standInApi: { readTask: mocks.readTask },
      deviceApi: { readWorkspaceFileChunk: vi.fn() },
      composerCatalogApi: { readCatalog: mocks.readCatalog },
    },
    state: {
      devices: mocks.devices,
      isBootstrapping: mocks.isBootstrapping,
      runtimeWork: mocks.runtimeWork,
    },
    projectChat: {
      inputByScope: mocks.inputByScope,
      setInputForScope: mocks.setInputForScope,
      listLocalApps: mocks.mainListApps,
      trialPluginName: 'Main plugin',
      trialTemplates: [{ name: 'Main task', path: 'main' }],
      contextUsage: { last: { totalTokens: 999 } },
      models: [],
      skills: [],
      selectedSkills: [],
      isOptionsLocked: false,
      toggleSkill: vi.fn(),
      selectedModel: null,
      continueInNewConversation: mocks.continueInNewConversation,
      setSelectedModel: mocks.setGlobalModel,
      setSelectedModelAndOptions: mocks.setGlobalModel,
      setSelectedModelOption: mocks.setGlobalModel,
      isModelSelectionReady: mocks.globalModelReady,
      selectedModelOptions: {},
      resolveRuntimeTaskModelSelection: (taskAddress: RuntimeTaskAddress) => {
        const selection =
          mocks.activeModelSelection ?? modelSelectionFromRuntimeHandle(taskAddress.runtimeHandle)
        const model = selection
          ? (mocks.runtimeModels.find(model => model.name === selection.modelName) ?? {
              name: selection.modelName,
              displayName: selection.modelName,
              type: selection.modelType,
            })
          : null
        return {
          selectionResolved:
            mocks.taskSelectionResolved ??
            Boolean(selection || taskAddress.runtimeHandle || mocks.runtimeWork !== null),
          selectionReady:
            mocks.taskSelectionResolved ??
            Boolean(selection || taskAddress.runtimeHandle || mocks.runtimeWork !== null),
          taskSelection: selection,
          selectedModel: model,
          activeModel: model,
          supportsModelProviderSwitch: taskAddress.runtimeHandle?.modelProviderRouting === 'thread',
          selectedModelOptions: selection?.options ?? {},
        }
      },
      setRuntimeTaskSelectedModel: vi.fn(),
      setRuntimeTaskSelectedModelAndOptions: vi.fn(),
      setRuntimeTaskSelectedModelOption: vi.fn(),
    },
    createTemporaryRuntimeTask: vi.fn(),
    createProjectRuntimeTask: mocks.createTask,
    sendRuntimePaneMessage: mocks.sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage: mocks.interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance: mocks.sendRuntimePaneGuidance,
    cancelRuntimePaneTask: mocks.cancelRuntimePaneTask,
    subscribeRuntimeTaskStream: (
      _address: RuntimeTaskAddress,
      handlers: { onContextUsageUpdated?: (usage: RuntimeContextUsage) => void }
    ) => {
      mocks.usageHandlers.push(handlers)
      return () => undefined
    },
    loadRuntimeTranscriptForPane: mocks.loadRuntimeTranscriptForPane,
    loadTurnFileChangesDiff: mocks.loadTurnFileChangesDiff,
    revertTurnFileChanges: mocks.revertTurnFileChanges,
  }),
}))

vi.mock('@/features/workbench/useWorkbenchAttachments', () => ({
  useWorkbenchAttachments: ({ scopeKey }: { scopeKey: string }) => ({
    attachments: [attachment],
    captureAttachmentsForScope: (scope: string) => (scope === scopeKey ? [attachment] : []),
    uploadingFiles: [],
    errors: new Map(),
    isAttachmentReadyToSend: true,
    handleFileSelect: vi.fn(),
    addExistingAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    resetAttachments: mocks.resetAttachments,
  }),
}))

vi.mock('@/features/workbench/runtimeModelSelection', async importOriginal => ({
  ...(await importOriginal<typeof runtimeModelSelection>()),
  selectedModelExecutionFields: (model: UnifiedModel | null, options: ModelOptions | undefined) =>
    model
      ? {
          modelId: model.name,
          modelType: model.type,
          modelOptions: options ?? {},
        }
      : {},
}))

vi.mock('@/features/workbench/runtimePaneStatus', () => ({
  deriveRuntimePaneStatus: () => ({ isBusy: mocks.busy }),
  isRuntimeTaskBusyError: () => mocks.busySendError,
}))

vi.mock('@/features/workbench/runtimeConversationCache', () => ({
  appendOptimisticRuntimeConversationGuidance: (
    _address: RuntimeTaskAddress,
    _turn: string,
    message: { id: string; content: string }
  ) => [{ ...message, role: 'user', status: 'pending', runtimeGuidance: true }],
  abortRuntimeConversationHydration: vi.fn(),
  getRuntimeConversationTurnIds: () => new Set<string>(),
  appendAcceptedRuntimeConversationMessage: (_address: RuntimeTaskAddress, message: unknown) => [
    message,
  ],
  applyRuntimeConversationAction: (
    _address: RuntimeTaskAddress,
    action: { type: string; message?: unknown }
  ) => (action.type === 'user_added' && action.message ? [action.message] : []),
  beginRuntimeConversationHydration: vi.fn(),
  completeRuntimeConversationHydration: () => mocks.conversationMessages,
  getRuntimeConversationMessages: () => mocks.conversationMessages,
  getRuntimeConversationTurns: () => mocks.conversationTurns,
  removeRuntimeConversationTurn: () => [],
  subscribeRuntimeConversation: () => () => undefined,
  updateRuntimeConversationBlocks: () => mocks.conversationMessages,
}))

vi.mock('@/features/workbench/runtimeTaskLifecycle', () => {
  let epoch = -1
  let revision = 0
  let previousSnapshot = mocks.lifecycleSnapshot
  const taskRevision = () => {
    if (previousSnapshot !== mocks.lifecycleSnapshot) {
      previousSnapshot = mocks.lifecycleSnapshot
      revision += 1
    }
    return revision
  }
  let store = {
    markRead: mocks.markRead,
    getTask: () => mocks.lifecycleSnapshot,
    getTaskRevision: taskRevision,
    syncTranscript: mocks.syncTranscript,
  }
  return {
    runtimeTaskLifecycleTransitionChanged: (a: unknown, b: unknown) => a !== b,
    useRuntimeTaskLifecycle: () => mocks.lifecycleSnapshot,
    useRuntimeTaskLifecycleStore: () => {
      if (epoch !== mocks.lifecycleOwnerEpoch) {
        epoch = mocks.lifecycleOwnerEpoch
        revision = 0
        previousSnapshot = mocks.lifecycleSnapshot
        store = {
          markRead: mocks.markRead,
          getTask: () => mocks.lifecycleSnapshot,
          getTaskRevision: taskRevision,
          syncTranscript: mocks.syncTranscript,
        }
      }
      return store
    },
  }
})

describe('TemporaryChatPanel', () => {
  beforeEach(() => {
    mocks.markRead.mockClear()
    mocks.windowFocused = true
    mocks.cancelRuntimePaneTask.mockClear()
    clearWorkbenchWorkspaceLaunch()
    mocks.renderToolBlocks = false
    mocks.inputHost = undefined
    mocks.devices = []
    mocks.mainListApps.mockClear()
    mocks.readCatalog.mockReset()
    mocks.readTask.mockReset()
    mocks.readCatalog.mockImplementation(async (target: RuntimeTaskAddress) => ({
      taskId: target.taskId,
      workspacePath: '/side',
      projectPluginIds: [],
      apps: [],
      skills: [],
      marketplaces: [],
      store: { storePath: '/store', plugins: [] },
      cloudInstalledPlugins: [],
    }))
    mocks.usageHandlers = []
    mocks.lifecycleOwnerEpoch++
    mocks.busy = false
    mocks.runtimeModels = []
    mocks.continueInNewConversation.mockClear()
    mocks.setGlobalModel.mockClear()
    mocks.busySendError = false
    mocks.interruptAndSendRuntimePaneMessage.mockClear()
    mocks.resetAttachments.mockReset()
    mocks.sendRuntimePaneMessage.mockReset()
    mocks.sendRuntimePaneMessage.mockResolvedValue(true)
    mocks.sendRuntimePaneGuidance.mockReset()
    mocks.createTask.mockReset()
    mocks.loadRuntimeTranscriptForPane.mockReset()
    mocks.loadRuntimeTranscriptForPane.mockResolvedValue({
      running: false,
      messages: [],
      turns: [],
      contextUsage: null,
      turnNavigation: [],
      fullContent: false,
      rangeStart: null,
      rangeEnd: null,
      hasMoreBefore: false,
      beforeCursor: null,
      hasMoreAfter: false,
      afterCursor: null,
    })
    mocks.syncTranscript.mockReset()
    mocks.loadTurnFileChangesDiff.mockReset()
    mocks.revertTurnFileChanges.mockReset()
    mocks.cancelRuntimePaneTask.mockReset()
    mocks.cancelRuntimePaneTask.mockResolvedValue(true)
    mocks.conversationMessages = []
    mocks.conversationTurns = []
    mocks.lifecycleSnapshot = null
    mocks.activeModelSelection = null
    mocks.isBootstrapping = false
    mocks.globalModelReady = true
    mocks.runtimeWork = null
    mocks.inputByScope = {}
    mocks.setInputForScope.mockReset()
    mocks.setInputForScope.mockImplementation((scope: string, value: string) => {
      if (value) mocks.inputByScope[scope] = value
      else delete mocks.inputByScope[scope]
    })
  })

  it('prioritizes the exact request message over its earlier user-turn alias', async () => {
    const question = {
      kind: 'request_user_input' as const,
      itemId: 'context-question',
      questions: [{ id: 'context', question: 'Choose the compatibility policy', is_other: true }],
    }
    mocks.conversationMessages = [
      { id: 'original-user', role: 'user', content: 'Review the order rules', status: 'done' },
      {
        id: 'request-context',
        role: 'assistant',
        content: 'The existing rules need a decision',
        status: 'done',
        blocks: [
          {
            id: 'question',
            type: 'tool',
            toolName: 'request_user_input_async',
            status: 'done',
            renderPayload: question,
          },
        ],
      },
    ] as typeof mocks.conversationMessages
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="exact-request"
        focusedRequest={question}
        sourceMessageIds={['request-context', 'original-user']}
        focusRequestKey="exact-request"
      />
    )
    expect(screen.getByTestId('mock-message-list')).toHaveAttribute(
      'data-target-message',
      'request-context'
    )
  })

  it('skips only the focused async request while another request stays answerable', async () => {
    const questions = ['first', 'second'].map(itemId => ({
      kind: 'request_user_input' as const,
      itemId,
      delivery: 'async' as const,
      questions: [{ id: itemId, question: `${itemId} decision?`, is_other: true }],
    }))
    mocks.conversationMessages = questions.map(question => ({
      id: question.itemId,
      role: 'assistant',
      content: '',
      status: 'done',
      blocks: [
        {
          id: question.itemId,
          type: 'tool',
          toolName: 'request_user_input_async',
          status: 'done',
          renderPayload: question,
        },
      ],
    })) as typeof mocks.conversationMessages
    const panel = (focusedRequest: (typeof questions)[number]) => (
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="skip-focused"
        focusedRequest={focusedRequest}
        focusRequestKey={focusedRequest.itemId}
      />
    )
    const view = render(panel(questions[0]))
    await userEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
    )
    view.rerender(panel(questions[1]))
    expect(screen.getByTestId('request-user-input-custom-second')).toBeVisible()
    expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
    expect(mocks.cancelRuntimePaneTask).not.toHaveBeenCalled()
    expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
  })

  it('skips only async questions in the displayed historical turn', async () => {
    mocks.conversationTurns = ['first', 'second'].map(id => ({
      id,
      clientUserMessageId: `${id}-user`,
      status: 'done',
      items: [
        {
          id: `${id}-user`,
          type: 'user_message',
          message: { id: `${id}-user`, role: 'user', content: `${id} context`, status: 'done' },
        },
        {
          id: `${id}-question`,
          type: 'block',
          block: {
            id: `${id}-question`,
            type: 'tool',
            toolName: 'request_user_input_async',
            status: 'done',
            createdAt: 1,
            renderPayload: {
              kind: 'request_user_input',
              itemId: `${id}-question`,
              delivery: 'async',
              interactionScope: id,
              questions: [{ id, question: `${id} decision?`, is_other: true }],
            },
          },
        },
      ],
    })) as typeof mocks.conversationTurns
    mocks.conversationMessages = projectRuntimeConversationTurns(mocks.conversationTurns)
    const panel = (id: string) => (
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="skip-history"
        historySource={{ turnId: id, userMessageIds: [`${id}-user`] }}
      />
    )
    const view = render(panel('first'))
    expect(screen.getByTestId('request-user-input-custom-first')).toBeVisible()
    await userEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
    )
    view.rerender(panel('second'))
    expect(screen.getByTestId('request-user-input-custom-second')).toBeVisible()
    expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(mocks.cancelRuntimePaneTask).not.toHaveBeenCalled()
  })

  it('shows the selected older question and targets its original turn instead of the latest request', async () => {
    const older = {
      kind: 'request_user_input' as const,
      itemId: 'older',
      questions: [{ id: 'old', question: 'Older decision?', is_other: true }],
    }
    mocks.conversationMessages = [
      { id: 'original-source', role: 'user', content: 'Earlier context', status: 'done' },
      {
        id: 'later',
        role: 'assistant',
        content: 'Unrelated later work',
        status: 'done',
        blocks: [
          {
            id: 'latest-block',
            type: 'tool',
            toolName: 'request_user_input_async',
            status: 'done',
            renderPayload: {
              kind: 'request_user_input',
              itemId: 'latest',
              questions: [{ id: 'new', question: 'Later decision?', is_other: true }],
            },
          },
        ],
      },
    ] as typeof mocks.conversationMessages
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="selected-question"
        focusedRequest={older}
        sourceMessageIds={['original-source']}
        focusRequestKey="older-notification"
      />
    )
    expect(screen.getByText('Older decision?')).toBeInTheDocument()
    expect(screen.queryByText('Later decision?')).not.toBeInTheDocument()
    expect(screen.getByTestId('mock-message-list')).toHaveAttribute(
      'data-target-message',
      'original-source'
    )
    await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
    expect(mocks.cancelRuntimePaneTask).not.toHaveBeenCalled()
    expect(screen.getByTestId('request-user-input-expand')).toHaveTextContent('Older decision?')
    expect(screen.getByTestId('request-user-input-custom-old')).not.toBeVisible()
    await userEvent.click(screen.getByTestId('request-user-input-expand'))
    expect(screen.getByTestId('request-user-input-custom-old')).toBeVisible()
  })

  it.each(['accepted', 'rejected', 'queued', 'pumped-queued'] as const)(
    'retains a folded question until the side composer message is delivered (%s)',
    async outcome => {
      mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
      mocks.busy = outcome === 'pumped-queued'
      const question = {
        kind: 'request_user_input' as const,
        itemId: 'held-question',
        delivery: 'async',
        questions: [{ id: 'audience', question: 'Who receives this?', is_other: true }],
      }
      mocks.conversationMessages = [
        {
          id: 'held-question-message',
          role: 'assistant',
          content: '',
          status: 'done',
          blocks: [
            {
              id: 'held-block',
              type: 'tool',
              toolName: 'request_user_input_async',
              status: 'done',
              renderPayload: question,
            },
          ],
        },
      ] as typeof mocks.conversationMessages
      const panel = () => (
        <TemporaryChatPanel
          currentProject={null}
          source={address}
          initialAddress={address}
          instanceId="held-question"
        />
      )
      const { rerender } = render(panel())
      setComposerValue(screen.getByTestId('request-user-input-custom-audience'), 'Saved recipients')
      await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
      let finish!: () => void
      mocks.sendRuntimePaneMessage.mockImplementationOnce(
        (...args: unknown[]) =>
          new Promise<boolean>(resolve => {
            const options = args[1] as { onQueued?: (response: { queuePosition: number }) => void }
            finish = () => {
              if (outcome === 'queued' || outcome === 'pumped-queued')
                options.onQueued?.({ queuePosition: 1 })
              resolve(outcome !== 'rejected')
            }
          })
      )
      expect(screen.getByTestId('mock-send')).toBeEnabled()
      await userEvent.click(screen.getByTestId('mock-send'))
      if (outcome === 'pumped-queued') {
        expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
        mocks.busy = false
        mocks.lifecycleSnapshot = {
          derived: { isRunning: false, isTurnActive: false },
          turn: { id: null },
        }
        rerender(panel())
      }
      await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce())
      expect(screen.getByTestId('request-user-input-expand')).toBeVisible()
      await act(async () => {
        finish()
      })
      if (outcome === 'accepted') {
        expect(screen.queryByTestId('request-user-input-expand')).not.toBeInTheDocument()
      } else {
        expect(screen.getByTestId('request-user-input-expand')).toBeVisible()
        await userEvent.click(screen.getByTestId('request-user-input-expand'))
        expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue(
          'Saved recipients'
        )
      }
      expect(mocks.cancelRuntimePaneTask).not.toHaveBeenCalled()
    }
  )

  it('restores only the selected controlled question after notification revalidation', () => {
    mocks.renderToolBlocks = true
    const question = {
      kind: 'request_user_input' as const,
      itemId: 'restored-request',
      questions: [{ id: 'question_1', question: 'Which rule applies?', is_other: true }],
    }
    mocks.conversationMessages = [
      {
        id: 'question-message',
        role: 'assistant',
        content: 'Original context',
        status: 'done',
        createdAt: '2026-09-10T00:00:00Z',
        blocks: [
          {
            id: 'question-tool',
            type: 'tool',
            toolName: 'request_user_input_async',
            status: 'done',
            renderPayload: question,
          },
        ],
      },
    ] as typeof mocks.conversationMessages
    mocks.inputHost = {
      getError: () => undefined,
      isDisabled: () => false,
      isSubmitting: () => false,
      getDraft: () => ({ question_1: 'Keep the old rule for existing customers.' }),
      setDraft: vi.fn(),
      submit: vi.fn(),
    }
    const panel = (focusedRequest: typeof question | null | undefined) => (
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="restored-notification"
        focusedRequest={focusedRequest}
        coordinateUserInput
      />
    )
    const { rerender } = render(panel(null))
    expect(screen.queryByTestId('request-user-input-custom-question_1')).not.toBeInTheDocument()
    rerender(panel(question))
    expect(screen.getAllByTestId('request-user-input-custom-question_1')).toHaveLength(1)
    expect(screen.getByTestId('request-user-input-custom-question_1')).toHaveValue(
      'Keep the old rule for existing customers.'
    )
    expect(screen.queryByTestId('runtime-input-submitting')).not.toBeInTheDocument()
    mocks.inputHost.isSubmitting = () => true
    mocks.inputHost.isDisabled = () => true
    rerender(panel(question))
    expect(screen.getByTestId('runtime-input-submitting')).toHaveTextContent(/正在发送|Sending/)
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    rerender(panel(null))
    expect(screen.queryByTestId('request-user-input-custom-question_1')).not.toBeInTheDocument()
    rerender(panel(undefined))
    expect(screen.getAllByTestId('request-user-input-custom-question_1')).toHaveLength(1)
    expect(screen.getByTestId('request-user-input-custom-question_1')).toHaveValue(
      'Keep the old rule for existing customers.'
    )
  })
})
