import enCommon from '@/i18n/locales/en/common.json'
import zhCommon from '@/i18n/locales/zh-CN/common.json'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { StrictMode, type ComponentProps } from 'react'
import { useStandInConversationModel } from '@/features/todo/useStandInConversationModel'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { WorkspaceStandInSettings } from '@wegent/collaboration'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToolBlocksDisplay } from '@/components/chat/blocks/ToolBlocksDisplay'
import {
  useComposerCatalogBinding,
  type ComposerCatalogBinding,
} from '@/components/chat/composer/ComposerCatalogContext'
import { RUNTIME_RETRY_CONTINUATION_PROMPT } from '@/components/layout/runtimeRetry'
import { runtimeTaskBindingAddress } from '@/features/todo/runtimeTaskBindingAddress'
import { modelSelectionFromRuntimeHandle } from '@/features/workbench/runtimeContextUsage'
import type {
  Attachment,
  DeviceInfo,
  LocalDeviceApp,
  ModelOptions,
  ModelSelectionConfig,
  RuntimeContextUsage,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import type { RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'
import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'
import { TemporaryChatPanel } from './TemporaryChatPanel'
import type { ConversationModelControls } from './conversationModelControls'
import * as runtimeModelSelection from '@/features/workbench/runtimeModelSelection'
import {
  clearWorkbenchWorkspaceLaunch,
  consumeWorkbenchWorkspaceLaunch,
} from '@/features/workbench/workspaceLaunchRequest'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'

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
  catalogBindings: new Map<string, ComposerCatalogBinding>(),
  devices: [] as DeviceInfo[],
  readCatalog: vi.fn(),
  readTask: vi.fn(),
  mainListApps: vi.fn(),
  usageHandlers: [] as Array<{ onContextUsageUpdated?: (usage: RuntimeContextUsage) => void }>,
  resetAttachments: vi.fn(),
  busy: false,
  realComposer: false,
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

function CatalogBindingProbe({ scope }: { scope?: string }) {
  const catalog = useComposerCatalogBinding()
  if (scope) mocks.catalogBindings.set(scope, catalog)
  return null
}

vi.mock('@/features/notifications/useRuntimeInteractionInputHost', () => ({
  useRuntimeInteractionInputHost: () => mocks.inputHost,
}))

vi.mock('@/components/chat/ScrollableMessageArea', () => ({
  ScrollableMessageArea: ({
    messages,
    onRetryFailedMessage,
    onSwitchModelForFailedMessage,
    onOpenWorkspaceFile,
    onOpenFileChangesReview,
    onOpenAssistantPlan,
    onRequestUserInputSubmit,
    onRequestUserInputIgnore,
    hasMoreBefore,
    loadingMoreBefore,
    onLoadMoreBefore,
    transcriptError,
    onRetryTranscript,
    messageTarget,
    hideRequestUserInputBlocks,
  }: {
    messages: Array<{
      id: string
      attachments?: Attachment[]
      role?: string
      content?: string
      status?: string
      blocks?: WorkbenchMessage['blocks']
    }>
    onRetryFailedMessage?: (message: unknown) => void
    onSwitchModelForFailedMessage?: (message: unknown) => void
    onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
    onOpenFileChangesReview?: () => void
    onOpenAssistantPlan?: () => void
    onRequestUserInputSubmit?: (response: {
      requestId: string
      answers: Record<string, { answers: string[] }>
    }) => void
    onRequestUserInputIgnore?: (payload: { kind: string; request_id: string }) => void
    hasMoreBefore?: boolean
    loadingMoreBefore?: boolean
    onLoadMoreBefore?: () => void
    transcriptError?: string | null
    onRetryTranscript?: () => void
    messageTarget?: { messageId: string; requestKey: string }
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
      {hasMoreBefore && (
        <button
          data-testid="mock-load-older"
          disabled={loadingMoreBefore}
          onClick={onLoadMoreBefore}
        >
          Older messages
        </button>
      )}
      {transcriptError && (
        <button data-testid="mock-retry-history" onClick={onRetryTranscript}>
          {transcriptError}
        </button>
      )}
      {messages.flatMap(message =>
        (message.attachments ?? []).map(messageAttachment => (
          <span key={messageAttachment.id} data-testid="sent-message-attachment">
            {messageAttachment.filename}:{messageAttachment.local_preview_url}
          </span>
        ))
      )}
      {onRetryFailedMessage &&
        messages
          .filter(message => message.role === 'assistant' && message.status === 'failed')
          .map(message => (
            <button
              key={message.id}
              type="button"
              data-testid="mock-retry"
              onClick={() => onRetryFailedMessage(message)}
            >
              重试
            </button>
          ))}
      {onSwitchModelForFailedMessage && messages[0] ? (
        <button
          type="button"
          data-testid="mock-switch-model"
          onClick={() => onSwitchModelForFailedMessage(messages[0])}
        >
          切换模型
        </button>
      ) : null}
      {onOpenWorkspaceFile ? (
        <button
          type="button"
          data-testid="mock-open-file"
          onClick={() =>
            onOpenWorkspaceFile('cart-fixture/cart-review.md', { lineStart: 3, lineEnd: 7 })
          }
        >
          打开文件
        </button>
      ) : null}
      {onOpenFileChangesReview ? (
        <button type="button" data-testid="mock-open-review" onClick={onOpenFileChangesReview}>
          打开 Review
        </button>
      ) : null}
      {onOpenAssistantPlan ? (
        <button type="button" data-testid="mock-open-plan" onClick={onOpenAssistantPlan}>
          打开 Plan
        </button>
      ) : null}
      {onRequestUserInputSubmit ? (
        <button
          type="button"
          data-testid="mock-submit-input"
          onClick={() =>
            onRequestUserInputSubmit({
              requestId: 'request-1',
              answers: { choice: { answers: ['继续'] } },
            })
          }
        >
          回答
        </button>
      ) : null}
      {onRequestUserInputIgnore ? (
        <button
          type="button"
          data-testid="mock-ignore-input"
          onClick={() =>
            onRequestUserInputIgnore({ kind: 'request_user_input', request_id: 'request-1' })
          }
        >
          忽略
        </button>
      ) : null}
    </div>
  ),
}))

vi.mock('@/components/layout/BufferedChatInput', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/layout/BufferedChatInput')>()
  const MockComposer = ({
    value,
    replaceDraftKey,
    onDraftEdit,
    onSubmit,
    disabled,
    submitDisabled,
    error,
    collapseWhenIdle,
    goalDraftActive,
    onSetGoal,
    onCancelGoalDraft,
    projectChat,
    queuedMessages,
    onSendQueuedAsGuidance,
  }: {
    value: string
    replaceDraftKey?: number
    onDraftEdit?: (value: string) => void
    onSubmit: (
      valueOverride?: string,
      options?: { interruptWhenBusy?: boolean }
    ) => Promise<boolean>
    queuedMessages?: Array<{ id: string; content: string }>
    onSendQueuedAsGuidance?: (id: string) => void
    disabled?: boolean
    submitDisabled?: boolean
    error?: string | null
    collapseWhenIdle?: boolean
    goalDraftActive?: boolean
    onSetGoal?: () => void
    onCancelGoalDraft?: () => void
    projectChat?: {
      scopeKey?: string
      activeModel?: UnifiedModel | null
      selectedModel?: UnifiedModel | null
      selectedModelOptions?: ModelOptions
      isModelSelectionReady?: boolean
      onModelSelectorOpenChange?: (open: boolean) => void
      contextUsage?: RuntimeContextUsage
      trialPluginName?: string
      showTrialGuide?: (title: string, app: LocalDeviceApp) => void
      dismissTrialGuide?: () => void
    }
  }) => (
    <div
      data-testid="mock-composer"
      data-draft-value={value}
      data-replace-draft-key={replaceDraftKey}
      data-collapse-when-idle={String(collapseWhenIdle)}
      data-selected-model={projectChat?.selectedModel?.name}
      data-active-model={projectChat?.activeModel?.name}
      data-selected-reasoning={projectChat?.selectedModelOptions?.reasoning}
      data-context-tokens={projectChat?.contextUsage?.last.totalTokens}
      data-trial-plugin={projectChat?.trialPluginName}
    >
      <CatalogBindingProbe scope={projectChat?.scopeKey} />
      <button
        type="button"
        data-testid="mock-model-selector"
        disabled={disabled}
        onClick={() => projectChat?.onModelSelectorOpenChange?.(true)}
      >
        Select model
      </button>
      <button
        type="button"
        data-testid="mock-edit-unpublished-draft"
        onClick={() => onDraftEdit?.('newer draft')}
      >
        Edit draft
      </button>
      <button
        type="button"
        data-testid="mock-select-plugin"
        onClick={() =>
          projectChat?.showTrialGuide?.('Side PDF', {
            id: 'pdf',
            name: 'Side PDF',
            trialTemplates: [{ name: 'Read', path: 'read' }],
          })
        }
      >
        Select plugin
      </button>
      <button
        type="button"
        data-testid="mock-dismiss-plugin"
        onClick={projectChat?.dismissTrialGuide}
      >
        Dismiss plugin
      </button>
      {onSetGoal ? (
        <button type="button" data-testid="set-goal-button" onClick={onSetGoal}>
          设置目标
        </button>
      ) : null}
      {goalDraftActive ? (
        <button type="button" data-testid="goal-draft-pill" onClick={onCancelGoalDraft}>
          目标
        </button>
      ) : null}
      <button
        type="button"
        data-testid="mock-send"
        disabled={disabled || submitDisabled || projectChat?.isModelSelectionReady === false}
        onClick={() => void onSubmit('发送附件')}
      >
        发送
      </button>
      <button
        data-testid="mock-interrupt"
        onClick={() => void onSubmit('立即发送', { interruptWhenBusy: true })}
      >
        打断发送
      </button>
      {queuedMessages?.map(message => (
        <span key={message.id} data-testid="mock-queue-row">
          {message.content}
          <button data-testid="mock-guide" onClick={() => onSendQueuedAsGuidance?.(message.id)}>
            Guide
          </button>
        </span>
      ))}
      {error ? <span data-testid="mock-error">{error}</span> : null}
    </div>
  )
  return {
    BufferedChatInput: (props: ComponentProps<typeof actual.BufferedChatInput>) =>
      mocks.realComposer ? <actual.BufferedChatInput {...props} /> : <MockComposer {...props} />,
  }
})

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
      selectedModelOptions: undefined,
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
  useWorkbenchAttachments: () => ({
    attachments: [attachment],
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
  it('keeps the stand-in usable and steers new messages while native subagents are running', async () => {
    mocks.busy = true
    mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
    mocks.lifecycleSnapshot = {
      turn: { id: 'parent-turn' },
      derived: { isRunning: true, isTurnActive: true },
    }
    mocks.sendRuntimePaneGuidance.mockResolvedValue({ sent: true, turnId: 'parent-turn' })
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="native-chat"
        nativeConversation
      />
    )
    await waitFor(() => expect(screen.getByTestId('mock-send')).toBeEnabled())
    await userEvent.click(screen.getByTestId('mock-send'))
    await waitFor(() => expect(mocks.sendRuntimePaneGuidance).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByTestId('mock-send')).toBeEnabled())
    await userEvent.click(screen.getByTestId('mock-send'))
    await waitFor(() => expect(mocks.sendRuntimePaneGuidance).toHaveBeenCalledTimes(2))
    expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(mocks.cancelRuntimePaneTask).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mock-queue-row')).not.toBeInTheDocument()
  })
  it('acknowledges visible stand-in messages only while the main window is focused', async () => {
    mocks.windowFocused = false
    mocks.lifecycleSnapshot = {
      unread: true,
      turn: { id: null },
      derived: { isRunning: false, isTurnActive: false },
    }
    const panel = (active: boolean) => (
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="read-stand-in"
        markReadWhenActive
        active={active}
      />
    )
    const view = render(panel(false))
    expect(mocks.markRead).not.toHaveBeenCalled()
    view.rerender(panel(true))
    expect(mocks.markRead).not.toHaveBeenCalled()
    act(() => {
      mocks.windowFocused = true
      mocks.focusListener?.(true)
    })
    expect(mocks.markRead).toHaveBeenCalledExactlyOnceWith(address)
    view.rerender(panel(false))
    expect(mocks.focusListener).toBeUndefined()
  })
  beforeEach(() => {
    mocks.markRead.mockClear()
    mocks.windowFocused = true
    mocks.cancelRuntimePaneTask.mockClear()
    clearWorkbenchWorkspaceLaunch()
    mocks.renderToolBlocks = false
    mocks.inputHost = undefined
    mocks.catalogBindings.clear()
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
    mocks.realComposer = false
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

  it('reads a cloud-bound local task catalog through its resolved IPC device', async () => {
    mocks.devices = [
      {
        id: 0,
        device_id: 'device-1',
        name: 'Local Executor',
        device_type: 'local',
        status: 'online',
        is_default: true,
        runtime_instance_id: 'runtime-1',
        runtime_routes: [
          {
            kind: 'cloud-relay',
            device_id: 'app-record-42',
            runtime_device_id: 'app-record-42',
            status: 'online',
          },
        ],
      },
    ]
    const bound = { ...address, deviceId: 'app-record-42' }
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={bound}
        initialAddress={bound}
        instanceId="registered-catalog"
      />
    )
    await waitFor(() => expect(mocks.catalogBindings.size).toBe(1))
    await mocks.catalogBindings.values().next().value!.listApps!()
    expect(mocks.readCatalog).toHaveBeenCalledWith(
      { deviceId: address.deviceId, taskId: address.taskId },
      true
    )
    expect(bound.deviceId).toBe('app-record-42')
  })

  it('preserves the first file action and line range while navigating to its owning task', async () => {
    mocks.conversationMessages = [
      {
        id: 'delivery',
        role: 'assistant',
        content: 'cart-review.md',
        status: 'done',
        createdAt: '',
      },
    ]
    const onOpenRuntimeTask = vi.fn(async () => {
      expect(
        consumeWorkbenchWorkspaceLaunch(address.deviceId, address.workspacePath!, 'wrong-task')
      ).toBeNull()
      expect(
        consumeWorkbenchWorkspaceLaunch(address.deviceId, address.workspacePath!, address.taskId)
      ).toEqual({
        taskId: address.taskId,
        openFile: {
          path: 'cart-fixture/cart-review.md',
          options: { lineStart: 3, lineEnd: 7 },
        },
      })
    })
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={null}
        instanceId="primary-deliverable"
        initialAddress={address}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )
    await userEvent.click(await screen.findByTestId('mock-open-file'))
    await waitFor(() => expect(onOpenRuntimeTask).toHaveBeenCalledExactlyOnceWith(address))
  })

  it('does not guess a workspace or attach another task metadata when opening a file', async () => {
    mocks.conversationMessages = [
      {
        id: 'delivery',
        role: 'assistant',
        content: 'cart-review.md',
        status: 'done',
        createdAt: '',
      },
    ]
    mocks.readTask.mockResolvedValue({ success: true, task: { ...address, taskId: 'other' } })
    const onOpenRuntimeTask = vi.fn()
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={null}
        instanceId="unresolved-deliverable"
        initialAddress={{ deviceId: address.deviceId, taskId: address.taskId }}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )
    await userEvent.click(await screen.findByTestId('mock-open-file'))
    await waitFor(() =>
      expect(mocks.readTask).toHaveBeenCalledWith(address.deviceId, address.taskId)
    )
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
    expect(
      consumeWorkbenchWorkspaceLaunch(address.deviceId, address.workspacePath!, address.taskId)
    ).toBeNull()
  })

  it('places contextual configuration decisions beside the composer and hides them when inactive', () => {
    const props = {
      currentProject: null,
      source: null,
      instanceId: 'configuration',
      composerHeader: <div data-testid="pending-configuration">Review changes</div>,
    }
    const { rerender } = render(<TemporaryChatPanel {...props} />)
    const decision = screen.getByTestId('pending-configuration')
    const composer = screen.getByTestId('mock-composer')
    expect(decision.parentElement).toContainElement(composer)
    expect(
      decision.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    rerender(<TemporaryChatPanel {...props} active={false} />)
    expect(screen.queryByTestId('pending-configuration')).not.toBeInTheDocument()
  })

  it('loads earlier pages, keeps messages on failure and retries the same cursor', async () => {
    const olderTurn: RuntimeConversationTurn = {
      id: 'older-turn',
      status: 'done',
      items: [
        {
          id: 'older',
          type: 'user_message',
          message: {
            id: 'older',
            role: 'user',
            content: 'Earlier question',
            status: 'done',
            createdAt: '',
          },
        },
      ],
    }
    mocks.conversationMessages = [
      {
        id: 'latest',
        role: 'assistant',
        content: 'Latest reply',
        status: 'done',
        createdAt: '',
      },
    ]
    mocks.loadRuntimeTranscriptForPane
      .mockResolvedValueOnce({ messages: [], turns: [], beforeCursor: 'older-page' })
      .mockRejectedValueOnce(new Error('Transfer interrupted'))
      .mockImplementationOnce(async () => {
        const transcript = { messages: [], turns: [olderTurn], beforeCursor: null }
        // The shared loader publishes canonical turns before resolving the page.
        mocks.conversationMessages = [
          ...transcript.turns.flatMap(turn =>
            turn.items.flatMap(item => (item.type === 'user_message' ? [item.message] : []))
          ),
          ...mocks.conversationMessages,
        ]
        return transcript
      })
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="paged-history"
        sendEphemeral={false}
      />
    )
    await userEvent.click(await screen.findByTestId('mock-load-older'))
    expect(await screen.findByTestId('mock-retry-history')).toHaveTextContent(
      'Transfer interrupted'
    )
    expect(screen.getByText('Latest reply')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mock-retry-history'))
    expect(await screen.findByText('Earlier question')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-load-older')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mock-retry-history')).not.toBeInTheDocument()
    expect(mocks.loadRuntimeTranscriptForPane).toHaveBeenLastCalledWith(address, {
      limit: 5,
      beforeCursor: 'older-page',
    })
    expect(mocks.loadRuntimeTranscriptForPane.mock.calls.slice(1)).toEqual([
      [address, { limit: 5, beforeCursor: 'older-page' }],
      [address, { limit: 5, beforeCursor: 'older-page' }],
    ])
  })

  it('retains cached messages and retries an initial load failure without a page cursor', async () => {
    mocks.conversationMessages = [
      {
        id: 'cached',
        role: 'assistant',
        content: 'Cached reply',
        status: 'done',
        createdAt: '',
      },
    ]
    mocks.loadRuntimeTranscriptForPane
      .mockRejectedValueOnce(new Error('Initial transfer interrupted'))
      .mockResolvedValueOnce({ messages: [], turns: [], beforeCursor: 'older-page' })
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="cached-history"
        sendEphemeral={false}
      />
    )
    expect(await screen.findByTestId('mock-retry-history')).toHaveTextContent(
      'Initial transfer interrupted'
    )
    expect(screen.getByText('Cached reply')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-load-older')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mock-retry-history'))
    expect(await screen.findByTestId('mock-load-older')).toBeInTheDocument()
    expect(screen.getByText('Cached reply')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-retry-history')).not.toBeInTheDocument()
    expect(mocks.loadRuntimeTranscriptForPane.mock.calls).toEqual([[address], [address]])
  })

  it('shows a history error instead of an empty conversation and retries the bound address', async () => {
    const address = {
      deviceId: 'admin-cloud',
      taskId: 'bound-session',
      projectSession: { projectId: 'p', issueId: 'i' },
    }
    mocks.loadRuntimeTranscriptForPane.mockRejectedValueOnce(new Error('Original executor offline'))
    mocks.loadRuntimeTranscriptForPane.mockResolvedValue({
      messages: [],
      turns: [],
      running: false,
    })
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="failed-history"
        sendEphemeral={false}
        emptyStateText="Actually empty"
      />
    )
    expect(screen.getByTestId('temporary-conversation-loading')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Original executor offline')
    )
    expect(screen.queryByText('Actually empty')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('temporary-conversation-retry'))
    await waitFor(() => expect(screen.getByText('Actually empty')).toBeInTheDocument())
    expect(mocks.loadRuntimeTranscriptForPane).toHaveBeenLastCalledWith(address)
  })

  it.each([
    {
      locale: 'zh-CN',
      title: '暂时无法加载会话',
      detail: '执行设备已离线，请恢复设备连接后重试。',
      retry: '重试',
      latest: '最近一条',
    },
    {
      locale: 'en',
      title: 'Conversation is temporarily unavailable',
      detail: 'The execution device is offline. Reconnect the device and try again.',
      retry: 'Retry',
      latest: 'Latest turn',
    },
  ])(
    'localizes the offline conversation and recovery controls in $locale',
    async ({ locale, title, detail, retry, latest }) => {
      const i18n = createInstance()
      await i18n.init({
        lng: locale,
        resources: { en: { common: enCommon }, 'zh-CN': { common: zhCommon } },
        defaultNS: 'common',
        interpolation: { escapeValue: false },
      })
      const offlineError = "device_offline: Device 'app-record-148' is offline"
      mocks.loadRuntimeTranscriptForPane.mockRejectedValueOnce(new Error(offlineError))
      const restore = vi.fn()
      render(
        <I18nextProvider i18n={i18n}>
          <TemporaryChatPanel
            currentProject={null}
            source={address}
            initialAddress={address}
            instanceId={`offline-${locale}`}
            sendEphemeral={false}
            expanded
            onRestoreConversation={restore}
          />
        </I18nextProvider>
      )
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(title)
      expect(alert).toHaveTextContent(detail)
      expect(alert).not.toHaveTextContent('activity.')
      expect(alert).not.toHaveTextContent(offlineError)
      expect(screen.getByTestId('temporary-conversation-retry')).toHaveTextContent(retry)
      await userEvent.click(screen.getByRole('button', { name: latest }))
      expect(restore).toHaveBeenCalledOnce()
      await userEvent.click(screen.getByRole('button', { name: retry }))
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      expect(mocks.loadRuntimeTranscriptForPane).toHaveBeenLastCalledWith(address)
    }
  )

  it('owns its plugin guide independently from the main workbench', async () => {
    const address = { deviceId: 'device-1', taskId: 'side-trial-task' }
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="side-trial"
        initialAddress={address}
        sendEphemeral={false}
      />
    )
    expect(screen.getByTestId('mock-composer')).not.toHaveAttribute('data-trial-plugin')
    await userEvent.click(screen.getByTestId('mock-select-plugin'))
    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-trial-plugin', 'Side PDF')
    await userEvent.click(screen.getByTestId('mock-dismiss-plugin'))
    expect(screen.getByTestId('mock-composer')).not.toHaveAttribute('data-trial-plugin')
  })

  it('lets an idle transcript settle a stale running execution without an active turn', async () => {
    mocks.lifecycleSnapshot = {
      derived: {
        isRunning: true,
        isTurnActive: false,
      },
    }

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="settled-task"
        initialAddress={address}
        sendEphemeral={false}
      />
    )

    await waitFor(() => expect(mocks.syncTranscript).toHaveBeenCalledTimes(1))
    expect(mocks.syncTranscript).toHaveBeenCalledWith(
      address,
      expect.objectContaining({ running: false }),
      { preserveActiveTurn: false }
    )
  })

  it('uses the same optimistic user message when creating a formal task', async () => {
    mocks.createTask.mockImplementation(async (_message, options) => {
      options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={null}
        instanceId="sidebar-test"
        createTask={mocks.createTask}
      />
    )

    await userEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(1))
    expect(mocks.createTask).toHaveBeenCalledWith(
      '发送附件',
      expect.objectContaining({
        optimisticUserMessage: expect.objectContaining({
          id: expect.stringMatching(/^queued-side-chat-/),
          role: 'user',
          content: '发送附件',
        }),
      })
    )
    expect(mocks.loadRuntimeTranscriptForPane).not.toHaveBeenCalled()
  })

  it('creates a new formal task with the submitted text as its initial goal', async () => {
    mocks.createTask.mockImplementation(async (_message, options) => {
      options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TemporaryChatPanel
        allowInitialGoal
        currentProject={null}
        source={null}
        instanceId="goal-task"
        createTask={mocks.createTask}
      />
    )

    await userEvent.click(screen.getByTestId('set-goal-button'))
    expect(screen.getByTestId('goal-draft-pill')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(1))
    expect(mocks.createTask).toHaveBeenCalledWith(
      '发送附件',
      expect.objectContaining({
        initialGoal: {
          objective: '发送附件',
          status: 'active',
          tokenBudget: null,
        },
      })
    )
    expect(screen.queryByTestId('goal-draft-pill')).not.toBeInTheDocument()
  })

  it.each([
    { existing: false, target: 'cloud', role: 'primary' },
    { existing: true, target: 'cloud', role: 'primary', threadRouting: true },
    { existing: true, target: 'custom', role: 'role-sales', threadRouting: true },
    { existing: true, target: 'cloud', role: 'primary' },
    { existing: false, target: 'custom', role: 'role-sales' },
    { existing: true, target: 'custom', role: 'role-sales' },
    { existing: true, target: 'cloud', role: 'primary', busy: true },
    { existing: true, target: 'cloud', role: 'primary', globalCatalogEmpty: true },
    { existing: true, target: 'cloud', role: 'primary', oldModelRemoved: true },
    { existing: true, target: 'cloud', role: 'primary', localCatalogFailed: true },
    { existing: true, target: 'cloud', role: 'primary', legacyProvider: true, retry: true },
    {
      existing: true,
      target: 'cloud',
      role: 'primary',
      legacyProvider: true,
      retry: true,
      hideProcessing: true,
    },
    { existing: true, target: 'official', role: 'primary', providerFailure: true },
    { existing: true, target: 'official', role: 'primary', providerPending: true },
    { existing: true, target: 'cloud', role: 'primary', revertBeforeSend: true },
    {
      existing: true,
      target: 'cloud',
      role: 'primary',
      providerPending: true,
      changeTargetRoundtrip: true,
    },
  ])(
    'sends the $role chat with a temporary $target model across providers (existing=$existing, removed=$oldModelRemoved, catalogFailed=$localCatalogFailed, outcome=$hideProcessing)',
    async ({
      existing,
      target,
      role,
      threadRouting = false,
      busy = false,
      globalCatalogEmpty = false,
      oldModelRemoved = false,
      localCatalogFailed = false,
      legacyProvider = false,
      retry = false,
      hideProcessing = false,
      providerFailure = false,
      providerPending = false,
      revertBeforeSend = false,
      changeTargetRoundtrip = false,
    }) => {
      mocks.realComposer = true
      mocks.busy = busy
      mocks.busySendError = busy
      if (busy) {
        mocks.sendRuntimePaneMessage.mockImplementation(async (_request, options) => {
          options.onError('Runtime task is already running')
          return false
        })
      }
      const actual = await vi.importActual<typeof runtimeModelSelection>(
        '@/features/workbench/runtimeModelSelection'
      )
      const selectionSpy = vi
        .spyOn(runtimeModelSelection, 'selectedModelExecutionFields')
        .mockImplementation(actual.selectedModelExecutionFields)
      const official: UnifiedModel = {
        name: oldModelRemoved ? 'gpt-5.5' : 'gpt-6.1-sol',
        type: 'runtime',
        provider: 'local',
        config: { weworkModelKind: 'codex-official', codexProviderId: 'openai' },
      }
      const cloud: UnifiedModel = {
        name: 'temporary-cloud',
        modelId: 'cloud-upstream',
        type: 'public',
        provider: 'openai',
        namespace: 'default',
        resourceUserId: 7,
        config: { protocol: 'openai-responses' },
      }
      const native = {
        runtime: 'codex' as const,
        provider: 'openai',
        model_id: official.name,
        label: 'ChatGPT Sol',
        is_default: true,
      }
      const profile: WorkspaceStandInSettings = {
        executionDeviceId: address.deviceId,
        enabled: true,
        prompt: '',
        version: 1,
        model: native,
        modelOptions: { reasoning: 'high' },
      }
      const before = structuredClone(profile)
      const services = {
        standInApi: {
          catalog: vi.fn(async () => {
            if (localCatalogFailed) throw new Error('Local catalog unavailable')
            return {
              models: [
                ...(oldModelRemoved ? [] : [native]),
                {
                  ...native,
                  provider: 'company',
                  model_id: 'company-codex',
                  label: 'Company Codex',
                  is_default: false,
                },
              ],
            }
          }),
        },
        modelApi: { listModels: vi.fn(async () => ({ data: [cloud] })) },
      } as unknown as WorkbenchServices
      const taskAddress = {
        ...address,
        taskId: `stand-in-chat-7-${role}`,
        threadId: 'original-thread',
        ...(threadRouting ? { runtimeHandle: { modelProviderRouting: 'thread' } } : {}),
      }
      mocks.runtimeModels = [
        official,
        cloud,
        {
          name: 'company-codex',
          type: 'runtime',
          provider: 'local',
          config: { weworkModelKind: 'codex-provider', codexProviderId: 'company' },
        },
      ]
      if (globalCatalogEmpty || localCatalogFailed) mocks.runtimeModels = []
      if (oldModelRemoved) {
        mocks.runtimeModels = mocks.runtimeModels.filter(model => model !== official)
      }
      mocks.activeModelSelection = {
        modelName: official.name,
        modelType: 'runtime',
        options: localCatalogFailed
          ? { runnerModelProvider: 'openai' }
          : { codexProviderId: 'openai' },
      }
      if (legacyProvider) {
        mocks.activeModelSelection = null
        mocks.readTask.mockResolvedValue({
          success: true,
          task: {
            ...taskAddress,
            runtimeHandle: {
              activeModelProvider: { threadId: taskAddress.threadId, provider: 'openai' },
            },
          },
        })
      }
      if (providerFailure) {
        mocks.activeModelSelection = null
        mocks.readTask.mockRejectedValue(new Error('thread not found'))
      }
      let releaseProviderRead: (() => void) | undefined
      const providerReads: Array<() => void> = []
      if (providerPending) {
        mocks.activeModelSelection = null
        mocks.readTask.mockImplementation(
          () =>
            new Promise(resolve => {
              let released = false
              releaseProviderRead = () => {
                if (released) return
                released = true
                resolve({
                  success: true,
                  task: {
                    ...taskAddress,
                    runtimeHandle: {
                      activeModelProvider: {
                        threadId: taskAddress.threadId,
                        provider: changeTargetRoundtrip ? 'router' : 'openai',
                      },
                    },
                  },
                })
              }
              providerReads.push(releaseProviderRead)
            })
        )
      }
      if (retry && hideProcessing) {
        mocks.conversationTurns = [
          {
            id: 'failed-turn',
            status: 'failed',
            error: 'Provider failed',
            items: [
              { id: 'ack', type: 'assistant_text', content: 'Received', createdAt: '' },
              {
                id: 'progress',
                type: 'assistant_text',
                content: 'Completed progress',
                createdAt: '',
              },
            ],
          },
        ]
        mocks.conversationMessages = projectRuntimeConversationTurns(mocks.conversationTurns)
      } else if (retry)
        mocks.conversationMessages = [
          {
            id: 'failed-turn',
            role: 'assistant',
            content: 'Provider failed',
            status: 'failed',
            createdAt: '2026-09-10T00:00:00Z',
          },
        ]
      mocks.createTask.mockResolvedValue(taskAddress)
      const i18n = createInstance()
      await i18n.init({
        lng: 'en',
        resources: { en: { common: enCommon } },
        defaultNS: 'common',
        interpolation: { escapeValue: false },
      })
      function Conversation() {
        const controls = useStandInConversationModel(services, profile)
        return (
          <I18nextProvider i18n={i18n}>
            <TemporaryChatPanel
              nativeConversation
              hideProcessing={hideProcessing}
              currentProject={null}
              source={null}
              instanceId={`switch-${role}-${existing}`}
              initialAddress={existing ? taskAddress : null}
              initialInput="Keep this stand-in draft"
              createTask={mocks.createTask}
              modelControls={controls}
            />
          </I18nextProvider>
        )
      }
      try {
        const view = render(<Conversation />)
        await waitFor(() => expect(services.standInApi.catalog).toHaveBeenCalled())
        if (oldModelRemoved || localCatalogFailed || providerFailure || providerPending) {
          await waitFor(() => expect(screen.getByTestId('send-message-button')).toBeDisabled())
          expect(screen.getByTestId('model-selector-button')).toBeEnabled()
        } else {
          await waitFor(() => expect(screen.getByTestId('send-message-button')).toBeEnabled())
        }
        await userEvent.click(screen.getByTestId('model-selector-button'))
        const advanced = screen.queryByTestId('model-advanced-toggle')
        if (advanced) await userEvent.click(advanced)
        const modelName =
          target === 'cloud' ? cloud.name : target === 'official' ? official.name : 'company-codex'
        await userEvent.click(await screen.findByTestId(`model-option-${modelName}`))
        if (existing) {
          expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
            threadRouting
              ? 'The new model will be used for the next message.'
              : 'Your next message will start a new session here.'
          )
          if (
            (target === 'cloud' || providerFailure || providerPending) &&
            !busy &&
            !oldModelRemoved &&
            !localCatalogFailed
          ) {
            await userEvent.click(screen.getByTestId('model-switch-warning-cancel-button'))
            expect(screen.getByTestId('model-selector-button')).toHaveTextContent('ChatGPT Sol')
            expect(mocks.continueInNewConversation).not.toHaveBeenCalled()
            if (providerFailure || providerPending)
              expect(screen.getByTestId('send-message-button')).toBeDisabled()
            await userEvent.click(screen.getByTestId('model-selector-button'))
            const advanced = screen.queryByTestId('model-advanced-toggle')
            if (advanced) await userEvent.click(advanced)
            await userEvent.click(await screen.findByTestId(`model-option-${modelName}`))
          }
          if (providerPending && !changeTargetRoundtrip) {
            expect(releaseProviderRead).toBeTypeOf('function')
            expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
            await act(async () => releaseProviderRead?.())
            expect(screen.getByTestId('send-message-button')).toBeEnabled()
            expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
              'Your next message will start a new session here.'
            )
          }
          await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))
        }
        if (changeTargetRoundtrip) {
          expect(releaseProviderRead).toBeTypeOf('function')
          await act(async () => releaseProviderRead?.())
          for (const name of ['company-codex', cloud.name]) {
            await userEvent.click(screen.getByTestId('model-selector-button'))
            const advanced = screen.queryByTestId('model-advanced-toggle')
            if (advanced) await userEvent.click(advanced)
            await userEvent.click(await screen.findByTestId(`model-option-${name}`))
            expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
            await userEvent.keyboard('{Escape}')
          }
        }
        expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
        await waitFor(() => expect(screen.getByTestId('send-message-button')).toBeEnabled())
        expect(screen.getByTestId('chat-message-input')).toHaveTextContent(
          'Keep this stand-in draft'
        )
        if (revertBeforeSend) {
          await userEvent.click(screen.getByTestId('model-selector-button'))
          const advanced = screen.queryByTestId('model-advanced-toggle')
          if (advanced) await userEvent.click(advanced)
          await userEvent.click(await screen.findByTestId(`model-option-${official.name}`))
          expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
        }
        await userEvent.click(screen.getByTestId(retry ? 'mock-retry' : 'send-message-button'))
        const executionTarget = revertBeforeSend ? 'official' : target
        const execution = {
          modelId: revertBeforeSend ? official.name : modelName,
          modelType: executionTarget === 'cloud' ? 'public' : 'runtime',
          modelOptions: expect.objectContaining(
            executionTarget === 'cloud'
              ? { weworkCloudModelResourceUserId: '7', weworkCloudModelNamespace: 'default' }
              : { codexProviderId: executionTarget === 'official' ? 'openai' : 'company' }
          ),
        }
        if (existing) {
          await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce())
          expect(mocks.sendRuntimePaneMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
              address: taskAddress,
              message: retry
                ? expect.stringContaining(RUNTIME_RETRY_CONTINUATION_PROMPT)
                : 'Keep this stand-in draft',
              ...execution,
              ...(!threadRouting && !revertBeforeSend && !changeTargetRoundtrip
                ? { startNewSession: true, expectedThreadId: taskAddress.threadId }
                : {}),
            }),
            expect.any(Object)
          )
          if (threadRouting || revertBeforeSend || changeTargetRoundtrip) {
            expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0]).not.toHaveProperty(
              'startNewSession'
            )
            expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0]).not.toHaveProperty(
              'expectedThreadId'
            )
          }
          if (retry) {
            const message = mocks.sendRuntimePaneMessage.mock.lastCall?.[0].message
            expect(message?.startsWith(`${RUNTIME_RETRY_CONTINUATION_PROMPT}\n\n`)).toBe(true)
            expect(message).toContain('wework_stand_in read_task')
            expect(message).toContain(
              `read_task(${JSON.stringify({ taskId: taskAddress.taskId })})`
            )
            expect(message).toContain('beforeCursor')
            expect(message).toContain('messageContentCursor')
            expect(message).toContain('do not guess the request or bypass the denial')
          }
        } else {
          await waitFor(() => expect(mocks.createTask).toHaveBeenCalledOnce())
          expect(mocks.createTask).toHaveBeenCalledWith(
            'Keep this stand-in draft',
            expect.objectContaining({ executionModel: expect.objectContaining(execution) })
          )
          expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
        }
        expect(mocks.continueInNewConversation).not.toHaveBeenCalled()
        expect(mocks.setGlobalModel).not.toHaveBeenCalled()
        expect(mocks.sendRuntimePaneGuidance).not.toHaveBeenCalled()
        expect(profile).toEqual(before)
        if (providerFailure || (providerPending && !changeTargetRoundtrip)) {
          mocks.lifecycleSnapshot = {
            task: {
              threadId: 'recovered-thread',
              modelSelection: {
                modelName,
                modelType: 'runtime',
                options: { codexProviderId: 'openai' },
              },
            },
            derived: { isRunning: false, isTurnActive: false },
          }
          view.rerender(<Conversation />)
          await userEvent.type(
            screen.getByTestId('chat-message-input'),
            'Continue recovered session'
          )
          await userEvent.click(screen.getByTestId('send-message-button'))
          await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(2))
          expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0]).not.toHaveProperty(
            'startNewSession'
          )
        }
        if (busy) {
          expect(screen.getByTestId('chat-message-input')).toHaveTextContent(
            'Keep this stand-in draft'
          )
        } else if (
          existing &&
          target === 'cloud' &&
          !oldModelRemoved &&
          !localCatalogFailed &&
          !revertBeforeSend &&
          !changeTargetRoundtrip &&
          !retry
        ) {
          // Runtime owns the latest thread even while the parent's address is unchanged.
          mocks.lifecycleSnapshot = {
            task: {
              threadId: threadRouting ? 'original-thread' : 'new-cloud-thread',
              modelSelection: { modelName, modelType: 'public' },
            },
            derived: { isRunning: false, isTurnActive: false },
          }
          view.rerender(<Conversation />)
          await userEvent.type(screen.getByTestId('chat-message-input'), 'Continue here')
          await userEvent.click(screen.getByTestId('send-message-button'))
          await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(2))
          expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0]).not.toHaveProperty(
            'startNewSession'
          )
          await userEvent.click(screen.getByTestId('model-selector-button'))
          const advanced = screen.queryByTestId('model-advanced-toggle')
          if (advanced) await userEvent.click(advanced)
          await userEvent.click(await screen.findByTestId(`model-option-${official.name}`))
          await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))
          await userEvent.type(screen.getByTestId('chat-message-input'), 'Use ChatGPT again')
          await userEvent.click(screen.getByTestId('send-message-button'))
          await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(3))
          expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0]).toMatchObject({
            modelId: official.name,
            ...(threadRouting
              ? {}
              : { startNewSession: true, expectedThreadId: 'new-cloud-thread' }),
          })
          if (threadRouting) {
            expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0]).not.toHaveProperty(
              'startNewSession'
            )
            expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0]).not.toHaveProperty(
              'expectedThreadId'
            )
            expect(mocks.sendRuntimePaneMessage.mock.lastCall?.[0].address.threadId).toBe(
              'original-thread'
            )
          }
          expect(profile).toEqual(before)
          expect(mocks.continueInNewConversation).not.toHaveBeenCalled()
          expect(mocks.setGlobalModel).not.toHaveBeenCalled()
        }
        view.unmount()
      } finally {
        await act(async () => providerReads.forEach(release => release()))
        selectionSpy.mockRestore()
      }
    }
  )

  it.each([
    ['loading', 'en'],
    ['loading', 'zh-CN'],
    ['unavailable', 'en'],
    ['unsupported', 'en'],
  ] as const)(
    'blocks retry while the stand-in model is %s in %s and recovers with a ready model',
    async (state, language) => {
      const i18n = createInstance()
      const common = language === 'en' ? enCommon : zhCommon
      await i18n.init({
        lng: language,
        resources: { [language]: { common } },
        defaultNS: 'common',
        interpolation: { escapeValue: false },
      })
      mocks.conversationMessages = [
        {
          id: 'failed',
          role: 'assistant',
          content: '',
          status: 'failed',
          createdAt: '2026-09-10T00:00:00Z',
        },
      ]
      const controls: ConversationModelControls = {
        models: [],
        selectedModel: { name: 'saved', type: 'runtime' },
        selectedModelOptions: {},
        loading: state === 'loading',
        unavailable: state !== 'loading',
        unavailableReason: state === 'unsupported' ? 'conversation_runtime_unsupported' : undefined,
        setSelectedModel: vi.fn(),
        setSelectedModelAndOptions: vi.fn(),
        setSelectedModelOption: vi.fn(),
      }
      const panel = (modelControls: ConversationModelControls) => (
        <I18nextProvider i18n={i18n}>
          <TemporaryChatPanel
            nativeConversation
            currentProject={null}
            source={null}
            instanceId="retry-model-readiness"
            initialAddress={address}
            modelControls={modelControls}
          />
        </I18nextProvider>
      )
      const view = render(panel(controls))
      await userEvent.click(screen.getByTestId('mock-retry'))
      expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
      expect(screen.getByTestId('mock-model-selector')).toBeEnabled()
      if (state === 'loading') {
        expect(screen.getByTestId('mock-error')).toHaveTextContent(
          common.standIn.errors.conversation_model_syncing
        )
      }
      view.rerender(
        panel({ ...controls, loading: false, unavailable: false, unavailableReason: undefined })
      )
      await userEvent.click(screen.getByTestId('mock-retry'))
      expect(mocks.sendRuntimePaneMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: RUNTIME_RETRY_CONTINUATION_PROMPT }),
        expect.any(Object)
      )
    }
  )

  it('uses inherited settings for the visible model and native follow-ups instead of the old task selection', async () => {
    mocks.activeModelSelection = {
      modelName: 'old-model',
      modelType: 'runtime',
      options: { reasoning: 'low' },
    }
    const controls: ConversationModelControls = {
      models: [],
      selectedModel: { name: 'saved-model', type: 'runtime' },
      selectedModelOptions: { reasoning: 'high' },
      loading: false,
      setSelectedModel: vi.fn(),
      setSelectedModelAndOptions: vi.fn(),
      setSelectedModelOption: vi.fn(),
    }
    const pane = (modelControls: ConversationModelControls) => (
      <TemporaryChatPanel
        nativeConversation
        currentProject={null}
        source={null}
        instanceId="inherited-conversation"
        initialAddress={address}
        modelControls={modelControls}
      />
    )
    let finishSend!: (accepted: boolean) => void
    const pending = new Promise<boolean>(resolve => {
      finishSend = resolve
    })
    mocks.sendRuntimePaneMessage.mockImplementationOnce(() => pending)
    const view = render(pane({ ...controls, loading: true }))
    expect(screen.getByTestId('mock-send')).toBeDisabled()
    view.rerender(pane(controls))
    try {
      expect(screen.getByTestId('mock-composer')).toHaveAttribute(
        'data-selected-model',
        'saved-model'
      )
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-selected-reasoning', 'high')
      await userEvent.click(screen.getByTestId('mock-send'))
      await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce())
      expect(mocks.sendRuntimePaneMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          address,
          modelId: 'saved-model',
          modelOptions: { reasoning: 'high' },
        }),
        expect.any(Object)
      )
      view.rerender(pane({ ...controls, selectedModelOptions: { reasoning: 'medium' } }))
      expect(screen.getByTestId('mock-composer')).toHaveAttribute(
        'data-selected-reasoning',
        'medium'
      )
      expect(screen.getByTestId('mock-send')).toBeDisabled()
      expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce()
      await act(async () => finishSend(true))
      expect(screen.getByTestId('mock-composer')).toHaveAttribute(
        'data-selected-reasoning',
        'medium'
      )
      await userEvent.click(screen.getByTestId('mock-send'))
      await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(2))
      expect(mocks.sendRuntimePaneMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          address,
          modelId: 'saved-model',
          modelOptions: { reasoning: 'medium' },
        }),
        expect.any(Object)
      )
    } finally {
      await act(async () => finishSend(true))
    }
  })

  it.each([{ loading: true }, { loading: false, unavailable: true }])(
    'keeps model recovery enabled while inherited selection is blocked by %j',
    async pending => {
      mocks.globalModelReady = false
      const controls: ConversationModelControls = {
        models: [],
        selectedModel: { name: 'saved-model', type: 'runtime' },
        selectedModelOptions: { reasoning: 'high' },
        loading: true,
        setSelectedModel: vi.fn(),
        setSelectedModelAndOptions: vi.fn(),
        setSelectedModelOption: vi.fn(),
        onModelSelectorOpenChange: vi.fn(),
      }
      const pane = (readiness: { loading: boolean; unavailable?: boolean }) => (
        <TemporaryChatPanel
          nativeConversation
          currentProject={null}
          source={null}
          instanceId="new-inherited-conversation"
          createTask={mocks.createTask}
          modelControls={{ ...controls, ...readiness }}
        />
      )
      const view = render(pane(pending))
      expect(screen.getByTestId('mock-send')).toBeDisabled()
      expect(screen.getByTestId('mock-model-selector')).toBeEnabled()
      await userEvent.click(screen.getByTestId('mock-model-selector'))
      expect(controls.onModelSelectorOpenChange).toHaveBeenCalledWith(true)
      await userEvent.click(screen.getByTestId('mock-interrupt'))
      expect(mocks.createTask).not.toHaveBeenCalled()
      view.rerender(pane({ loading: false, unavailable: false }))
      await userEvent.click(screen.getByTestId('mock-send'))
      await waitFor(() => expect(mocks.createTask).toHaveBeenCalledOnce())
      expect(mocks.createTask).toHaveBeenCalledWith(
        '发送附件',
        expect.objectContaining({
          executionModel: {
            modelId: 'saved-model',
            modelType: 'runtime',
            modelOptions: { reasoning: 'high' },
          },
        })
      )
    }
  )

  it.each([
    { locale: 'zh-CN', existing: false },
    { locale: 'en', existing: true },
  ])(
    'shows Claude recovery before submitting a $locale conversation',
    async ({ locale, existing }) => {
      const actual = await vi.importActual<typeof runtimeModelSelection>(
        '@/features/workbench/runtimeModelSelection'
      )
      const selectionSpy = vi
        .spyOn(runtimeModelSelection, 'selectedModelExecutionFields')
        .mockImplementation(actual.selectedModelExecutionFields)
      try {
        const i18n = createInstance()
        await i18n.init({
          lng: locale,
          resources: { en: { common: enCommon }, 'zh-CN': { common: zhCommon } },
          defaultNS: 'common',
          interpolation: { escapeValue: false },
        })
        const replacement: UnifiedModel = {
          name: 'selected-codex',
          type: 'runtime',
          modelId: 'selected-codex',
          runtime: { family: 'codex', provider: 'selected-provider' },
          config: { codexProviderId: 'selected-provider' },
        }
        const controls: ConversationModelControls = {
          models: [replacement],
          selectedModel: {
            name: 'saved-claude',
            type: 'runtime',
            runtime: { family: 'claude_code', provider: 'claude' },
          },
          selectedModelOptions: {},
          loading: true,
          unavailable: true,
          unavailableReason: 'conversation_runtime_unsupported',
          setSelectedModel: vi.fn(),
          setSelectedModelAndOptions: vi.fn(),
          setSelectedModelOption: vi.fn(),
        }
        const pane = (current: ConversationModelControls) => (
          <I18nextProvider i18n={i18n}>
            <TemporaryChatPanel
              nativeConversation
              currentProject={null}
              source={null}
              instanceId="claude-recovery"
              initialAddress={existing ? address : null}
              initialInput="Keep this draft"
              createTask={mocks.createTask}
              modelControls={current}
            />
          </I18nextProvider>
        )
        const view = render(pane(controls))
        expect(screen.getByTestId('mock-composer')).not.toHaveAttribute('data-active-model')
        expect(screen.getByTestId('mock-error')).toHaveTextContent(
          i18n.t('standIn.errors.conversation_runtime_unsupported')
        )
        expect(screen.getByTestId('mock-model-selector')).toBeEnabled()
        expect(screen.getByTestId('mock-send')).toBeDisabled()
        await userEvent.click(screen.getByTestId('mock-interrupt'))
        expect(mocks.createTask).not.toHaveBeenCalled()
        expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
        expect(screen.getByTestId('mock-composer')).toHaveAttribute(
          'data-draft-value',
          'Keep this draft'
        )
        view.rerender(pane({ ...controls, loading: false }))
        expect(screen.getByTestId('mock-send')).toBeDisabled()
        expect(screen.getByTestId('mock-error')).toBeVisible()
        view.rerender(
          pane({
            ...controls,
            loading: false,
            unavailable: false,
            unavailableReason: undefined,
            selectedModel: replacement,
          })
        )
        expect(screen.queryByTestId('mock-error')).not.toBeInTheDocument()
        expect(screen.getByTestId('mock-send')).toBeEnabled()
        await userEvent.click(screen.getByTestId('mock-send'))
        const selected = {
          modelId: 'selected-codex',
          modelType: 'runtime',
          modelOptions: expect.objectContaining({ codexProviderId: 'selected-provider' }),
        }
        if (existing) {
          await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce())
          expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
            expect.objectContaining({ address, ...selected }),
            expect.any(Object)
          )
        } else {
          await waitFor(() => expect(mocks.createTask).toHaveBeenCalledOnce())
          expect(mocks.createTask).toHaveBeenCalledWith(
            '发送附件',
            expect.objectContaining({ executionModel: expect.objectContaining(selected) })
          )
        }
      } finally {
        selectionSpy.mockRestore()
      }
    }
  )

  it('continues an existing task with its immutable model instead of the global default', async () => {
    mocks.activeModelSelection = {
      modelName: 'moonshot-kimi-k2.7-code-highspeed',
      modelType: 'public',
      options: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
      },
    }

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="moonshot-task"
        initialAddress={address}
      />
    )

    expect(screen.getByTestId('mock-composer')).toHaveAttribute(
      'data-selected-model',
      'moonshot-kimi-k2.7-code-highspeed'
    )
    await userEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(1))
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        modelId: 'moonshot-kimi-k2.7-code-highspeed',
        modelType: 'public',
        modelOptions: {
          weworkCloudModelNamespace: 'default',
          weworkCloudModelResourceUserId: '0',
        },
      }),
      expect.any(Object)
    )
  })

  it('uses the bound remote agent model for the composer and follow-up request before task-list hydration', async () => {
    const selection: ModelSelectionConfig = {
      modelName: 'deepseek-v4-pro-responses(公网)',
      modelType: 'public',
      options: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
      },
    }
    const boundAddress = runtimeTaskBindingAddress({
      device_id: 'remote-device',
      task_id: 'codex-queue-85',
      modelSelection: selection,
    })

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={boundAddress}
        instanceId="bound-remote-task"
        initialAddress={boundAddress}
      />
    )

    expect(screen.getByTestId('mock-composer')).toHaveAttribute(
      'data-selected-model',
      selection.modelName
    )
    await userEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(1))
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: boundAddress,
        modelId: selection.modelName,
        modelType: selection.modelType,
        modelOptions: selection.options,
      }),
      expect.any(Object)
    )
  })

  it('blocks an existing task until its immutable model identity is available', async () => {
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="pending-model-task"
        initialAddress={address}
      />
    )

    expect(screen.getByTestId('mock-send')).toBeDisabled()
    expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
  })

  it('lets a legacy task select a model after runtime work finishes without an identity', () => {
    mocks.runtimeWork = {
      projects: [],
      chats: [],
      totalTasks: 0,
    }

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="legacy-task-without-model"
        initialAddress={address}
      />
    )

    expect(screen.getByTestId('mock-send')).toBeEnabled()
  })

  it('auto-submits the initial input once after the task model identity is available', async () => {
    mocks.activeModelSelection = {
      modelName: 'moonshot-kimi-k2.7-code-highspeed',
      modelType: 'public',
      options: {},
    }

    render(
      <StrictMode>
        <TemporaryChatPanel
          autoSubmitInitialInput
          currentProject={null}
          initialAddress={address}
          initialInput="自动发送"
          instanceId="auto-submit-task"
          source={address}
        />
      </StrictMode>
    )

    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(1))
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        message: '自动发送',
        modelId: 'moonshot-kimi-k2.7-code-highspeed',
      }),
      expect.any(Object)
    )
  })

  it('appends an example once without discarding a draft or sending it', async () => {
    const consumed = vi.fn()
    const props = {
      currentProject: null,
      source: address,
      instanceId: 'example-draft',
      initialAddress: address,
      initialInput: 'Existing notes',
      draftRequest: { id: 1, text: 'Prepare my next meeting' },
      onDraftRequestConsumed: consumed,
    }
    const { rerender } = render(<TemporaryChatPanel {...props} />)
    await waitFor(() =>
      expect(screen.getByTestId('mock-composer')).toHaveAttribute(
        'data-draft-value',
        'Existing notes\n\nPrepare my next meeting'
      )
    )
    rerender(<TemporaryChatPanel {...props} />)
    expect(consumed).toHaveBeenCalledTimes(1)
    expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it('restores an identity draft after navigation, isolates other identities and clears it after send', async () => {
    mocks.activeModelSelection = {
      modelName: 'gpt-5.6-codex',
      modelType: 'public',
      options: {},
    }
    const props = {
      currentProject: null,
      source: address,
      instanceId: 'stand-in:primary',
      initialAddress: address,
    }
    const draft = '在指定群里有人 @我时，先拟好回复。'
    const first = render(<TemporaryChatPanel {...props} draftRequest={{ id: 1, text: draft }} />)
    await waitFor(() =>
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', draft)
    )
    first.unmount()
    const next = render(<TemporaryChatPanel {...props} />)
    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', draft)
    next.rerender(<TemporaryChatPanel {...props} instanceId="stand-in:other-role" />)
    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', '')
    next.rerender(<TemporaryChatPanel {...props} />)
    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', draft)
    await userEvent.click(screen.getByTestId('mock-send'))
    await waitFor(() =>
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', '')
    )
    next.unmount()
    render(<TemporaryChatPanel {...props} />)
    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', '')
  })

  it.each(['runtime', 'creation'] as const)(
    'leaves a rejected %s submission for the buffered input to restore',
    async failure => {
      mocks.activeModelSelection = {
        modelName: 'gpt-5.6-codex',
        modelType: 'public',
        options: {},
      }
      mocks.sendRuntimePaneMessage.mockResolvedValue(false)
      mocks.createTask.mockResolvedValue(false)
      render(
        <TemporaryChatPanel
          currentProject={null}
          source={address}
          instanceId="buffered-submit-recovery"
          initialAddress={failure === 'runtime' ? address : null}
          initialInput="initial draft"
          createTask={failure === 'creation' ? mocks.createTask : undefined}
        />
      )

      await userEvent.click(screen.getByTestId('mock-send'))

      expect(
        failure === 'runtime' ? mocks.sendRuntimePaneMessage : mocks.createTask
      ).toHaveBeenCalledOnce()
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', '')
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-replace-draft-key', '0')
    }
  )

  it.each(['false', 'rejection'] as const)(
    'restores the initial draft explicitly after automatic submission returns %s',
    async outcome => {
      mocks.activeModelSelection = {
        modelName: 'gpt-5.6-codex',
        modelType: 'public',
        options: {},
      }
      let finishSend!: () => void
      mocks.sendRuntimePaneMessage.mockImplementation(
        () =>
          new Promise<boolean>((resolve, reject) => {
            finishSend = () =>
              outcome === 'false' ? resolve(false) : reject(new Error('send failed'))
          })
      )
      render(
        <TemporaryChatPanel
          autoSubmitInitialInput
          currentProject={null}
          source={address}
          instanceId="automatic-submit-recovery"
          initialAddress={address}
          initialInput="initial draft"
        />
      )
      await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce())
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', '')

      await act(async () => finishSend())

      expect(screen.getByTestId('mock-composer')).toHaveAttribute(
        'data-draft-value',
        'initial draft'
      )
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-replace-draft-key', '1')
    }
  )

  it('keeps an unpublished edit when automatic submission fails', async () => {
    mocks.activeModelSelection = {
      modelName: 'gpt-5.6-codex',
      modelType: 'public',
      options: {},
    }
    let finishSend!: () => void
    mocks.sendRuntimePaneMessage.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          finishSend = () => resolve(false)
        })
    )
    render(
      <TemporaryChatPanel
        autoSubmitInitialInput
        currentProject={null}
        source={address}
        instanceId="automatic-submit-newer-draft"
        initialAddress={address}
        initialInput="initial draft"
      />
    )
    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce())
    await userEvent.click(screen.getByTestId('mock-edit-unpublished-draft'))

    await act(async () => finishSend())

    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', '')
    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-replace-draft-key', '0')
  })

  it.each(['instance', 'address'] as const)(
    'does not restore an automatic draft after its %s changes',
    async changedTarget => {
      mocks.activeModelSelection = {
        modelName: 'gpt-5.6-codex',
        modelType: 'public',
        options: {},
      }
      let finishSend!: () => void
      mocks.sendRuntimePaneMessage.mockImplementation(
        () =>
          new Promise<boolean>(resolve => {
            finishSend = () => resolve(false)
          })
      )
      const props = {
        autoSubmitInitialInput: true,
        currentProject: null,
        source: address,
        instanceId: 'automatic-submit-original-target',
        initialAddress: address,
        initialInput: 'initial draft',
      }
      const { rerender } = render(<TemporaryChatPanel {...props} />)
      await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledOnce())
      rerender(
        <TemporaryChatPanel
          {...props}
          instanceId={changedTarget === 'instance' ? 'another-instance' : props.instanceId}
          initialAddress={
            changedTarget === 'address' ? { ...address, taskId: 'another-task' } : address
          }
        />
      )

      await act(async () => finishSend())

      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-draft-value', '')
      expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-replace-draft-key', '0')
    }
  )

  it('replaces the composer with pending confirmation and submits its native response', async () => {
    mocks.conversationMessages = [
      {
        id: 'assistant-approval',
        role: 'assistant',
        content: '准备发送回复。',
        status: 'done',
        createdAt: '2026-10-24T00:00:00Z',
        blocks: [
          {
            id: 'approval',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            renderPayload: {
              kind: 'request_user_input',
              requestId: 'approval-9',
              questions: [
                {
                  id: 'mcp_tool_call_approval_reply',
                  question: '发送这条回复？',
                  options: [{ label: 'Allow' }, { label: 'Cancel' }],
                },
              ],
            },
          },
        ],
      },
    ]
    const view = render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="composer-approval"
      />
    )
    expect(screen.queryByTestId('mock-composer')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-chat-composer-shell')).toContainElement(
      screen.getByTestId('request-user-input-card')
    )
    view.rerender(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="composer-approval"
        active={false}
      />
    )
    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mock-composer')).not.toBeInTheDocument()
    view.rerender(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId="composer-approval"
        active
      />
    )
    await userEvent.click(
      screen.getByTestId('request-user-input-option-mcp_tool_call_approval_reply-0')
    )
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        requestUserInputResponse: {
          requestId: 'approval-9',
          itemId: undefined,
          answers: { mcp_tool_call_approval_reply: { answers: ['Allow'] } },
        },
      })
    )
  })

  it('handles retry and runtime input actions inside the temporary conversation', async () => {
    mocks.activeModelSelection = {
      modelName: 'gpt-5.6-codex',
      modelType: 'public',
      options: {},
    }
    mocks.conversationMessages = [
      {
        id: 'failed-assistant',
        role: 'assistant',
        content: '',
        status: 'failed',
        createdAt: '2026-09-10T00:00:00Z',
      },
    ]

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="local-actions"
        initialAddress={address}
      />
    )

    await userEvent.click(screen.getByTestId('mock-retry'))
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        message: RUNTIME_RETRY_CONTINUATION_PROMPT,
        modelId: 'gpt-5.6-codex',
      }),
      expect.any(Object)
    )

    await userEvent.click(screen.getByTestId('mock-submit-input'))
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        message: '继续',
        requestUserInputResponse: expect.objectContaining({ requestId: 'request-1' }),
      })
    )

    await userEvent.click(screen.getByTestId('mock-ignore-input'))
    expect(mocks.cancelRuntimePaneTask).toHaveBeenCalledWith(address)
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
      await userEvent.type(
        screen.getByTestId('request-user-input-custom-audience'),
        'Saved recipients'
      )
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
  it('uses the shared pending queue while busy and drains it after becoming idle', async () => {
    mocks.busy = true
    mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
    const { rerender } = render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="queue"
        initialAddress={address}
      />
    )
    await userEvent.click(screen.getByTestId('mock-send'))
    expect(screen.getByTestId('mock-queue-row')).toHaveTextContent('发送附件')
    expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
    mocks.busy = false
    mocks.lifecycleSnapshot = {
      derived: { isRunning: false, isTurnActive: false },
      turn: { id: null },
    }
    rerender(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="queue"
        initialAddress={address}
      />
    )
    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('mock-queue-row')).toBeNull())
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        message: '发送附件',
        attachments: [expect.objectContaining({ local_path: attachment.local_path })],
      }),
      expect.any(Object)
    )
  })
  it('drains after lifecycle settlement without a per-panel stream callback', async () => {
    mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
    const panel = (
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="settlement"
        initialAddress={address}
      />
    )
    const { rerender } = render(panel)
    await userEvent.click(screen.getByTestId('mock-send'))
    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(1))
    mocks.busy = true
    mocks.lifecycleSnapshot = {
      derived: { isRunning: true, isTurnActive: true },
      turn: { id: 'active-turn' },
    }
    rerender(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="settlement"
        initialAddress={address}
      />
    )
    await userEvent.click(screen.getByTestId('mock-send'))
    expect(screen.getByTestId('mock-queue-row')).toBeInTheDocument()
    mocks.busy = false
    mocks.lifecycleSnapshot = {
      derived: { isRunning: false, isTurnActive: false },
      turn: { id: null },
    }
    rerender(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="settlement"
        initialAddress={address}
      />
    )
    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('mock-queue-row')).toBeNull())
  })

  it('drains a busy rejection when the external turn settled while the send was pending', async () => {
    mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
    mocks.busySendError = true
    mocks.lifecycleSnapshot = {
      derived: { isRunning: false, isTurnActive: false },
      turn: { id: null },
    }
    let rejectBusy!: () => void
    mocks.sendRuntimePaneMessage.mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          rejectBusy = () => resolve(false)
        })
    )
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="busy-rejection-settled"
        initialAddress={address}
      />
    )
    await userEvent.click(screen.getByTestId('mock-send'))
    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(1))
    await act(async () => {
      // A background result turn may complete before the rejected send returns.
      mocks.lifecycleSnapshot = {
        derived: { isRunning: false, isTurnActive: false },
        turn: { id: null },
      }
      rejectBusy()
    })
    await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('mock-queue-row')).toBeNull())
  })

  it.each([false, true])(
    'sends a failed guidance row without an active turn (executor running: %s)',
    async executorRunning => {
      mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
      mocks.busy = true
      mocks.lifecycleSnapshot = {
        derived: { isRunning: true, isTurnActive: true },
        turn: { id: 'active-turn' },
      }
      mocks.sendRuntimePaneGuidance.mockResolvedValue({
        sent: false,
        error: 'no active turn to guide',
      })
      const { rerender } = render(
        <TemporaryChatPanel
          currentProject={null}
          source={address}
          instanceId="idle-guidance"
          initialAddress={address}
        />
      )
      await userEvent.click(screen.getByTestId('mock-send'))
      await userEvent.click(screen.getByTestId('mock-guide'))
      await waitFor(() => expect(mocks.sendRuntimePaneGuidance).toHaveBeenCalledTimes(1))
      mocks.busy = executorRunning
      mocks.lifecycleSnapshot = {
        derived: { isRunning: executorRunning, isTurnActive: false },
        turn: { id: null },
      }
      rerender(
        <TemporaryChatPanel
          currentProject={null}
          source={address}
          instanceId="idle-guidance"
          initialAddress={address}
        />
      )
      await userEvent.click(screen.getByTestId('mock-guide'))
      await waitFor(() => expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledTimes(1))
      expect(mocks.sendRuntimePaneGuidance).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByTestId('mock-queue-row')).toBeNull())
    }
  )
  it('preserves the task queue when its drawer closes and reopens', async () => {
    mocks.busy = true
    mocks.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
    const first = render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="queue-first"
        initialAddress={address}
      />
    )
    await userEvent.click(screen.getByTestId('mock-send'))
    first.unmount()
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="queue-reopened"
        initialAddress={address}
      />
    )
    expect(screen.getByTestId('mock-queue-row')).toHaveTextContent('发送附件')
    expect(mocks.sendRuntimePaneMessage).not.toHaveBeenCalled()
  })
})
