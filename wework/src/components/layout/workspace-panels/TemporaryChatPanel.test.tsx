import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Attachment, ModelSelectionConfig, RuntimeTaskAddress } from '@/types/api'
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
  syncTranscript: vi.fn(),
  lifecycleSnapshot: null as {
    derived: {
      isRunning: boolean
      isTurnActive: boolean
    }
  } | null,
  activeModelSelection: null as ModelSelectionConfig | null,
}))

vi.mock('@/components/chat/ScrollableMessageArea', () => ({
  ScrollableMessageArea: ({ messages }: { messages: Array<{ attachments?: Attachment[] }> }) => (
    <div data-testid="mock-message-list">
      {messages.flatMap(message =>
        (message.attachments ?? []).map(messageAttachment => (
          <span key={messageAttachment.id} data-testid="sent-message-attachment">
            {messageAttachment.filename}:{messageAttachment.local_preview_url}
          </span>
        ))
      )}
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
  }: {
    onSubmit: (valueOverride?: string) => Promise<boolean>
    disabled?: boolean
    error?: string | null
    collapseWhenIdle?: boolean
    goalDraftActive?: boolean
    onSetGoal?: () => void
    onCancelGoalDraft?: () => void
  }) => (
    <div data-testid="mock-composer" data-collapse-when-idle={String(collapseWhenIdle)}>
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
    state: { devices: [], runtimeWork: null },
    projectChat: {
      models: [],
      selectedModel: null,
      selectedModelOptions: undefined,
    },
    createTemporaryRuntimeTask: vi.fn(),
    sendRuntimePaneMessage: mocks.sendRuntimePaneMessage,
    sendRuntimePaneGuidance: vi.fn(),
    cancelRuntimePaneTask: vi.fn(),
    subscribeRuntimeTaskStream: () => () => undefined,
    loadRuntimeTranscriptForPane: mocks.loadRuntimeTranscriptForPane,
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
  selectedModelExecutionFields: () => ({
    modelId: 'gpt-5.6-sol',
    modelType: 'runtime',
    modelOptions: { reasoningEffort: 'high' },
  }),
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
  getRuntimeConversationMessages: () => [],
  removeRuntimeConversationTurn: () => [],
  subscribeRuntimeConversation: () => () => undefined,
}))

vi.mock('@/features/workbench/temporaryChatModelContext', () => ({
  resolveTemporaryChatActiveModel: () => null,
  resolveTemporaryChatModelSelection: () => mocks.activeModelSelection,
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
    mocks.lifecycleSnapshot = null
    mocks.activeModelSelection = null
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
})
