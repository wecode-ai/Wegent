import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  Attachment,
  ModelOptions,
  ModelSelectionConfig,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import { RUNTIME_RETRY_CONTINUATION_PROMPT } from '@/components/layout/runtimeRetry'
import { TemporaryChatPanel } from './TemporaryChatPanel'

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
  resetAttachments: vi.fn(),
  sendRuntimePaneMessage: vi.fn(async () => true),
  createTask: vi.fn(),
  loadRuntimeTranscriptForPane: vi.fn(),
  loadTurnFileChangesDiff: vi.fn(),
  revertTurnFileChanges: vi.fn(),
  cancelRuntimePaneTask: vi.fn(async () => true),
  syncTranscript: vi.fn(),
  conversationMessages: [] as Array<{
    id: string
    role: 'assistant' | 'user'
    content: string
    status: 'done' | 'failed'
    createdAt: string
  }>,
  lifecycleSnapshot: null as {
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
  }: {
    messages: Array<{
      id: string
      attachments?: Attachment[]
      role?: string
      content?: string
      status?: string
    }>
    onRetryFailedMessage?: (message: unknown) => void
    onSwitchModelForFailedMessage?: (message: unknown) => void
    onOpenWorkspaceFile?: (path: string) => void
    onOpenFileChangesReview?: () => void
    onOpenAssistantPlan?: () => void
    onRequestUserInputSubmit?: (response: {
      requestId: string
      answers: Record<string, { answers: string[] }>
    }) => void
    onRequestUserInputIgnore?: (payload: { kind: string; request_id: string }) => void
  }) => (
    <div data-testid="mock-message-list">
      {messages.flatMap(message =>
        (message.attachments ?? []).map(messageAttachment => (
          <span key={messageAttachment.id} data-testid="sent-message-attachment">
            {messageAttachment.filename}:{messageAttachment.local_preview_url}
          </span>
        ))
      )}
      {onRetryFailedMessage && messages[0] ? (
        <button
          type="button"
          data-testid="mock-retry"
          onClick={() => onRetryFailedMessage(messages[0])}
        >
          重试
        </button>
      ) : null}
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
          onClick={() => onOpenWorkspaceFile('/tmp/workspace/file.ts')}
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

vi.mock('@/components/layout/BufferedChatInput', () => ({
  BufferedChatInput: ({
    onSubmit,
    disabled,
    error,
    collapseWhenIdle,
    goalDraftActive,
    onSetGoal,
    onCancelGoalDraft,
    projectChat,
  }: {
    onSubmit: (valueOverride?: string) => Promise<boolean>
    disabled?: boolean
    error?: string | null
    collapseWhenIdle?: boolean
    goalDraftActive?: boolean
    onSetGoal?: () => void
    onCancelGoalDraft?: () => void
    projectChat?: { selectedModel?: UnifiedModel | null }
  }) => (
    <div
      data-testid="mock-composer"
      data-collapse-when-idle={String(collapseWhenIdle)}
      data-selected-model={projectChat?.selectedModel?.name}
    >
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
        disabled={disabled}
        onClick={() => void onSubmit('发送附件')}
      >
        发送
      </button>
      {error ? <span data-testid="mock-error">{error}</span> : null}
    </div>
  ),
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    services: {},
    state: {
      devices: [],
      isBootstrapping: mocks.isBootstrapping,
      runtimeWork: mocks.runtimeWork,
    },
    projectChat: {
      models: [],
      selectedModel: null,
      selectedModelOptions: undefined,
      resolveRuntimeTaskModelSelection: () => {
        const selection = mocks.activeModelSelection
        const model = selection
          ? {
              name: selection.modelName,
              displayName: selection.modelName,
              type: selection.modelType,
            }
          : null
        return {
          taskSelection: selection,
          selectedModel: model,
          activeModel: model,
          selectedModelOptions: selection?.options ?? {},
        }
      },
      setRuntimeTaskSelectedModel: vi.fn(),
      setRuntimeTaskSelectedModelAndOptions: vi.fn(),
      setRuntimeTaskSelectedModelOption: vi.fn(),
    },
    createTemporaryRuntimeTask: vi.fn(),
    sendRuntimePaneMessage: mocks.sendRuntimePaneMessage,
    sendRuntimePaneGuidance: vi.fn(),
    cancelRuntimePaneTask: mocks.cancelRuntimePaneTask,
    subscribeRuntimeTaskStream: () => () => undefined,
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

vi.mock('@/features/workbench/runtimeModelSelection', () => ({
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
  deriveRuntimePaneStatus: () => ({ isBusy: false }),
  isRuntimeTaskBusyError: () => false,
}))

vi.mock('@/features/workbench/runtimeConversationCache', () => ({
  abortRuntimeConversationHydration: vi.fn(),
  applyRuntimeConversationAction: (
    _address: RuntimeTaskAddress,
    action: { type: string; message?: unknown }
  ) => (action.type === 'user_added' && action.message ? [action.message] : []),
  beginRuntimeConversationHydration: vi.fn(),
  completeRuntimeConversationHydration: vi.fn(),
  getRuntimeConversationMessages: () => mocks.conversationMessages,
  removeRuntimeConversationTurn: () => [],
  subscribeRuntimeConversation: () => () => undefined,
  updateRuntimeConversationBlocks: () => mocks.conversationMessages,
}))

vi.mock('@/features/workbench/runtimeTaskLifecycle', () => ({
  useRuntimeTaskLifecycle: () => mocks.lifecycleSnapshot,
  useRuntimeTaskLifecycleStore: () => ({
    getTask: () => mocks.lifecycleSnapshot,
    syncTranscript: mocks.syncTranscript,
  }),
}))

describe('TemporaryChatPanel', () => {
  beforeEach(() => {
    mocks.resetAttachments.mockReset()
    mocks.sendRuntimePaneMessage.mockClear()
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
    mocks.lifecycleSnapshot = null
    mocks.activeModelSelection = null
    mocks.isBootstrapping = false
    mocks.runtimeWork = null
  })

  it('passes the collapsed idle state through to the shared composer', () => {
    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="collapsed-composer"
        initialAddress={address}
        collapseComposerWhenIdle
      />
    )

    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-collapse-when-idle', 'true')
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

  it('keeps sent attachments on the user message after clearing the composer', async () => {
    mocks.activeModelSelection = {
      modelName: 'moonshot-kimi-k2.7-code-highspeed',
      modelType: 'public',
      options: {},
    }

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={null}
        instanceId="sidebar-test"
        initialAddress={address}
      />
    )

    await userEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() =>
      expect(screen.getByTestId('sent-message-attachment')).toHaveTextContent(
        'sidebar-image.png:/tmp/sidebar-image.png'
      )
    )
    expect(mocks.resetAttachments).toHaveBeenCalledTimes(1)
    expect(mocks.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        message: '发送附件',
        attachments: [attachment],
      }),
      expect.any(Object)
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

  it('does not offer initial Goal mode when continuing an existing task', () => {
    mocks.activeModelSelection = {
      modelName: 'moonshot-kimi-k2.7-code-highspeed',
      modelType: 'public',
      options: {},
    }

    render(
      <TemporaryChatPanel
        allowInitialGoal
        currentProject={null}
        source={address}
        instanceId="existing-goal-task"
        initialAddress={address}
      />
    )

    expect(screen.queryByTestId('set-goal-button')).not.toBeInTheDocument()
  })

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
      })
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

  it('returns task-page actions to the current runtime task', async () => {
    mocks.conversationMessages = [
      {
        id: 'assistant',
        role: 'assistant',
        content: 'Open the workspace result',
        status: 'done',
        createdAt: '2026-09-10T00:00:00Z',
      },
    ]
    const onOpenRuntimeTask = vi.fn()

    render(
      <TemporaryChatPanel
        currentProject={null}
        source={address}
        instanceId="task-page-actions"
        initialAddress={address}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    await userEvent.click(screen.getByTestId('mock-open-file'))
    await userEvent.click(screen.getByTestId('mock-open-review'))
    await userEvent.click(screen.getByTestId('mock-open-plan'))
    await userEvent.click(screen.getByTestId('mock-switch-model'))

    expect(onOpenRuntimeTask).toHaveBeenCalledTimes(4)
    expect(onOpenRuntimeTask).toHaveBeenCalledWith(address)
  })
})
