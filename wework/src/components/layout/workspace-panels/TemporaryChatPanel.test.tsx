import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskAddress } from '@/types/api'
import { TemporaryChatPanel } from './TemporaryChatPanel'
import { disposeTemporaryChatPanel } from './temporaryChatPanelLifecycle'

const workbenchPaneContextMock = vi.hoisted(() => ({
  value: null as WorkbenchPaneContextValue | null,
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => {
    if (!workbenchPaneContextMock.value) {
      throw new Error('Missing workbench pane context mock')
    }
    return workbenchPaneContextMock.value
  },
}))

vi.mock('@/components/chat/ScrollableMessageArea', () => ({
  ScrollableMessageArea: ({ messages }: { messages: { content: string }[] }) => (
    <div data-testid="mock-scrollable-message-area">
      {messages.map(message => (
        <div key={message.content}>{message.content}</div>
      ))}
    </div>
  ),
}))

vi.mock('@/components/layout/BufferedChatInput', () => ({
  BufferedChatInput: ({
    value,
    onChange,
    onSubmit,
  }: {
    value: string
    onChange: (value: string) => void
    onSubmit: (value?: string) => void
  }) => (
    <form
      onSubmit={event => {
        event.preventDefault()
        onSubmit(value)
      }}
    >
      <input
        data-testid="temporary-chat-input"
        value={value}
        onChange={event => onChange(event.target.value)}
      />
      <button data-testid="temporary-chat-submit-button" type="submit">
        Send
      </button>
    </form>
  ),
}))

function createMockContext(address: RuntimeTaskAddress, unsubscribe: () => void) {
  return {
    state: { devices: [] },
    projectChat: {
      attachments: [],
      resetAttachments: vi.fn(),
      selectedModel: null,
      selectedModelOptions: {},
    },
    createTemporaryRuntimeTask: vi.fn().mockResolvedValue(address),
    sendRuntimePaneMessage: vi.fn().mockResolvedValue(true),
    cancelRuntimePaneTask: vi.fn().mockResolvedValue(true),
    subscribeRuntimeTaskStream: vi.fn(() => unsubscribe),
    loadRuntimeTranscriptForPane: vi.fn().mockResolvedValue({ messages: [] }),
  } as unknown as WorkbenchPaneContextValue
}

describe('TemporaryChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workbenchPaneContextMock.value = null
    disposeTemporaryChatPanel('chat:test')
  })

  test('keeps the runtime stream subscription when the panel unmounts', async () => {
    const unsubscribe = vi.fn()
    const address = {
      deviceId: 'local-device',
      taskId: 'temporary-task',
      workspacePath: '/tmp/workspace',
    }
    const context = createMockContext(address, unsubscribe)
    workbenchPaneContextMock.value = context

    const { unmount } = render(
      <TemporaryChatPanel currentProject={null} source={address} instanceId="chat:test" />
    )

    fireEvent.change(screen.getByTestId('temporary-chat-input'), {
      target: { value: '你好' },
    })
    fireEvent.click(screen.getByTestId('temporary-chat-submit-button'))

    await waitFor(() => {
      expect(context.subscribeRuntimeTaskStream).toHaveBeenCalledWith(
        address,
        expect.objectContaining({
          onMessageAction: expect.any(Function),
        })
      )
    })

    unmount()
    expect(unsubscribe).not.toHaveBeenCalled()

    disposeTemporaryChatPanel('chat:test')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
