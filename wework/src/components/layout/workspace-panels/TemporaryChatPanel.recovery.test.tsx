import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
} from '@/features/workbench/runtimeConversationCache'
import { synchronizeRuntimeConversation } from '@/features/workbench/runtimeConversationSynchronization'
import { TemporaryChatPanel } from './TemporaryChatPanel'

const address: RuntimeTaskAddress = { deviceId: 'device', taskId: 'temporary-chat' }
const mocks = vi.hoisted(() => ({
  loadTranscript: vi.fn(),
  readTranscript: vi.fn(),
  lifecycleStore: {
    getTask: () => null,
    getTaskRevision: () => 0,
    syncTranscript: vi.fn(),
  },
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    services: {},
    state: { devices: [], isBootstrapping: false, runtimeWork: { projects: [], chats: [] } },
    projectChat: {
      models: [],
      selectedModel: null,
      resolveRuntimeTaskModelSelection: () => ({
        taskSelection: null,
        activeModel: null,
        selectedModel: null,
        selectedModelOptions: {},
      }),
    },
    subscribeRuntimeTaskStream: () => () => undefined,
    loadRuntimeTranscriptForPane: mocks.loadTranscript,
  }),
}))

vi.mock('@/features/workbench/runtimeTaskLifecycle', () => ({
  useRuntimeTaskLifecycle: () => null,
  useRuntimeTaskLifecycleStore: () => mocks.lifecycleStore,
}))

vi.mock('@/features/workbench/useWorkbenchAttachments', () => ({
  useWorkbenchAttachments: () => ({ attachments: [], uploadingFiles: [], errors: new Map() }),
}))

vi.mock('@/components/chat/composer/useRuntimeComposerCatalog', () => ({
  useRuntimeComposerCatalog: () => ({}),
}))

vi.mock('@/components/layout/BufferedChatInput', () => ({
  BufferedChatInput: () => <div data-testid="recovery-composer" />,
}))

vi.mock('@/components/chat/ScrollableMessageArea', () => ({
  ScrollableMessageArea: ({ messages }: { messages: WorkbenchMessage[] }) => (
    <div data-testid="recovered-messages">
      {messages.map(message => (
        <p key={message.id}>{message.content}</p>
      ))}
    </div>
  ),
}))

function transcript(content = 'Saved side reply'): RuntimeTranscriptResponse {
  return {
    runtime: 'codex',
    workspacePath: '/workspace',
    threadId: 'ephemeral-thread',
    running: false,
    messages: [],
    turns: [
      {
        id: 'saved-turn',
        status: 'done',
        items: [
          {
            id: 'saved-question',
            type: 'user_message',
            message: { id: 'saved-question', role: 'user', content: 'Saved side question' },
          },
          { id: 'saved-answer', type: 'assistant_text', content },
        ],
      },
    ],
  }
}

function mountConversation(target = address) {
  return render(
    <TemporaryChatPanel
      currentProject={null}
      source={null}
      instanceId={target.taskId}
      initialAddress={target}
    />
  )
}

describe('TemporaryChatPanel executor-cache recovery', () => {
  beforeEach(() => {
    mocks.readTranscript.mockReset()
    mocks.readTranscript.mockResolvedValue(transcript())
    mocks.loadTranscript.mockReset()
    mocks.loadTranscript.mockImplementation((target: RuntimeTaskAddress) =>
      synchronizeRuntimeConversation(mocks.readTranscript, target)
    )
    mocks.lifecycleStore.syncTranscript.mockReset()
  })

  afterEach(() => {
    cleanup()
    clearRuntimeConversationCacheForTests()
    vi.useRealTimers()
  })

  it('restores an open ephemeral conversation after its unmounted cache expires', async () => {
    vi.useFakeTimers()
    await synchronizeRuntimeConversation(async () => transcript(), address)
    const first = mountConversation()
    expect(screen.getByText('Saved side reply')).toBeInTheDocument()
    expect(mocks.loadTranscript).not.toHaveBeenCalled()

    // Switching the main task unmounts its temporary panel while preserving its address.
    first.unmount()
    act(() => vi.advanceTimersByTime(5 * 60 * 1000 - 1))
    expect(getRuntimeConversationMessages(address)).toHaveLength(2)
    act(() => vi.advanceTimersByTime(1))
    expect(getRuntimeConversationMessages(address)).toEqual([])

    await act(async () => {
      mountConversation()
    })

    expect(mocks.loadTranscript).toHaveBeenCalledExactlyOnceWith(address)
    expect(mocks.readTranscript).toHaveBeenCalledExactlyOnceWith(address)
    expect(screen.getAllByText('Saved side question')).toHaveLength(1)
    expect(screen.getAllByText('Saved side reply')).toHaveLength(1)
    expect(mocks.lifecycleStore.syncTranscript).toHaveBeenCalledWith(
      address,
      expect.objectContaining({ running: false }),
      { preserveActiveTurn: false }
    )
  })

  it('reuses a mounted or recently cached ephemeral conversation without reading history', async () => {
    vi.useFakeTimers()
    await synchronizeRuntimeConversation(async () => transcript(), address)
    const first = mountConversation()
    act(() => vi.advanceTimersByTime(5 * 60 * 1000))
    expect(screen.getByText('Saved side reply')).toBeInTheDocument()
    first.unmount()
    act(() => vi.advanceTimersByTime(5 * 60 * 1000 - 1))
    mountConversation()
    expect(screen.getByText('Saved side reply')).toBeInTheDocument()
    expect(mocks.loadTranscript).not.toHaveBeenCalled()
  })

  it('shows a recovery error and retries the same ephemeral task', async () => {
    let resolveRetry!: (response: RuntimeTranscriptResponse) => void
    mocks.readTranscript.mockRejectedValueOnce(new Error('Executor temporarily unavailable'))
    mocks.readTranscript.mockReturnValueOnce(
      new Promise<RuntimeTranscriptResponse>(resolve => {
        resolveRetry = resolve
      })
    )
    mountConversation()
    expect(screen.getByTestId('temporary-conversation-loading')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Executor temporarily unavailable')
    await userEvent.click(screen.getByTestId('temporary-conversation-retry'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('temporary-conversation-loading')).toBeInTheDocument()
    await act(async () => resolveRetry(transcript()))
    expect(await screen.findByText('Saved side reply')).toBeInTheDocument()
    expect(mocks.readTranscript.mock.calls).toEqual([[address], [address]])
  })

  it('keeps another task visible when an unmounted recovery finishes late', async () => {
    let resolveFirst!: (response: RuntimeTranscriptResponse) => void
    mocks.readTranscript.mockReturnValueOnce(
      new Promise<RuntimeTranscriptResponse>(resolve => {
        resolveFirst = resolve
      })
    )
    const first = mountConversation()
    await waitFor(() => expect(mocks.readTranscript).toHaveBeenCalledOnce())
    first.unmount()
    const secondAddress = { ...address, taskId: 'another-temporary-chat' }
    mocks.readTranscript.mockResolvedValueOnce(transcript('Another task reply'))
    mountConversation(secondAddress)
    expect(await screen.findByText('Another task reply')).toBeInTheDocument()

    await act(async () => resolveFirst(transcript()))

    expect(screen.getByText('Another task reply')).toBeInTheDocument()
    expect(screen.queryByText('Saved side reply')).not.toBeInTheDocument()
    expect(mocks.lifecycleStore.syncTranscript).toHaveBeenCalledOnce()
    expect(mocks.lifecycleStore.syncTranscript).toHaveBeenCalledWith(
      secondAddress,
      expect.any(Object),
      { preserveActiveTurn: false }
    )
  })

  it('preserves a newer live turn when a delayed cached transcript resolves', async () => {
    let resolveRead!: (response: RuntimeTranscriptResponse) => void
    mocks.readTranscript.mockReturnValueOnce(
      new Promise<RuntimeTranscriptResponse>(resolve => {
        resolveRead = resolve
      })
    )
    mountConversation()
    await waitFor(() => expect(mocks.readTranscript).toHaveBeenCalledOnce())
    act(() => {
      applyRuntimeConversationAction(address, {
        type: 'assistant_started',
        subtaskId: 'new-live-turn',
      })
      applyRuntimeConversationAction(address, {
        type: 'assistant_done',
        subtaskId: 'new-live-turn',
        itemId: 'new-live-answer',
        content: 'New live reply',
      })
    })
    expect(screen.getByText('New live reply')).toBeInTheDocument()

    await act(async () => resolveRead(transcript()))

    expect(screen.getAllByText('New live reply')).toHaveLength(1)
    expect(screen.getAllByText('Saved side reply')).toHaveLength(1)
  })
})
