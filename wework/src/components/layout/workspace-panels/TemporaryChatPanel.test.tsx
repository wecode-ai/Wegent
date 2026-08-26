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
  }: {
    onSubmit: (valueOverride?: string) => Promise<boolean>
    disabled?: boolean
    error?: string | null
  }) => (
    <>
      <button
        type="button"
        data-testid="mock-send"
        disabled={disabled}
        onClick={() => void onSubmit('发送附件')}
      >
        发送
      </button>
      {error ? <span data-testid="mock-error">{error}</span> : null}
    </>
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
    loadRuntimeTranscriptForPane: vi.fn(),
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
  useRuntimeTaskLifecycle: () => null,
  useRuntimeTaskLifecycleStore: () => ({
    getTask: () => null,
    syncTranscript: vi.fn(),
  }),
}))

describe('TemporaryChatPanel', () => {
  beforeEach(() => {
    mocks.resetAttachments.mockReset()
    mocks.sendRuntimePaneMessage.mockClear()
    mocks.createTask.mockReset()
    mocks.activeModelSelection = null
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
