import { act, renderHook, waitFor } from '@testing-library/react'
import { useChatStreamHandlers } from '@/features/tasks/components/chat/useChatStreamHandlers'
import type { TaskDetail } from '@/types/api'
import type React from 'react'

const mockContextSendMessage = jest.fn()
const mockSetTaskInputMessage = jest.fn()
const mockSetIsLoading = jest.fn()
const mockResetAttachment = jest.fn()
const mockResetContexts = jest.fn()
const mockScrollToBottom = jest.fn()
const mockAddUserMessage = jest.fn()
const mockUpdateUserMessage = jest.fn()
const mockToast = jest.fn()

let isMachineStreamingMock = true
let selectedTaskDetailMock = {
  id: 42,
  status: 'RUNNING',
  is_group_chat: false,
  subtasks: [],
} as unknown as TaskDetail

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/chat',
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    selectedTaskDetail: selectedTaskDetailMock,
    refreshTasks: jest.fn(),
    refreshSelectedTaskDetail: jest.fn(),
    markTaskAsViewed: jest.fn(),
  }),
}))

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useChatStreamContext: () => ({
    sendMessage: mockContextSendMessage,
    stopStream: jest.fn(),
    clearVersion: 0,
  }),
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ retryMessage: jest.fn() }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({ selectedDeviceId: null }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 7 } }),
}))

jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({
    traceAction: (_name: string, _attrs: Record<string, string>, fn: () => unknown) => fn(),
  }),
}))

jest.mock('@/features/tasks/hooks/useTaskStateMachine', () => ({
  useTaskStateMachine: () => ({
    state: { messages: new Map(), isStopping: false },
    isStreaming: isMachineStreamingMock,
  }),
}))

jest.mock('@/features/tasks/state', () => ({
  generateMessageId: () => 'local-user-1',
  taskStateManager: {
    getOrCreate: () => ({
      addUserMessage: mockAddUserMessage,
      updateUserMessage: mockUpdateUserMessage,
    }),
  },
}))

function renderQueueableHook() {
  return renderHook(() =>
    useChatStreamHandlers({
      selectedTeam: { id: 5, name: 'Team' } as never,
      selectedModel: null,
      forceOverride: false,
      setSelectedModel: jest.fn(),
      setForceOverride: jest.fn(),
      selectedRepo: null,
      selectedBranch: null,
      showRepositorySelector: false,
      effectiveRequiresWorkspace: false,
      taskInputMessage: 'next question',
      setTaskInputMessage: mockSetTaskInputMessage,
      setIsLoading: mockSetIsLoading,
      enableDeepThinking: false,
      enableClarification: false,
      externalApiParams: {},
      attachments: [
        {
          id: 11,
          filename: 'ready.txt',
          status: 'ready',
        },
      ] as never,
      resetAttachment: mockResetAttachment,
      isAttachmentReadyToSend: true,
      taskType: 'chat',
      shouldHideChatInput: false,
      scrollToBottom: mockScrollToBottom,
      selectedContexts: [],
      resetContexts: mockResetContexts,
      additionalSkills: [],
    })
  )
}

describe('useChatStreamHandlers queue integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    isMachineStreamingMock = true
    selectedTaskDetailMock = {
      id: 42,
      status: 'RUNNING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail
  })

  it('queues a follow-up locally instead of sending immediately while the active task is streaming', async () => {
    const { result } = renderQueueableHook()

    await act(async () => {
      await result.current.handleSendMessage()
    })

    expect(mockContextSendMessage).not.toHaveBeenCalled()
    expect(mockAddUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'local-user-1',
        type: 'user',
        status: 'pending',
        queued: true,
        queueStatus: 'queued',
        content: 'next question',
      })
    )
    expect(mockSetTaskInputMessage).toHaveBeenCalledWith('')
    expect(mockResetAttachment).toHaveBeenCalled()
    expect(mockResetContexts).toHaveBeenCalled()
  })

  it('does not expose queue availability for a pending task unless it is streaming or awaiting response', () => {
    isMachineStreamingMock = false
    selectedTaskDetailMock = {
      id: 42,
      status: 'PENDING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail

    const { result } = renderQueueableHook()

    expect(result.current.canQueueMessage).toBe(false)
  })

  it('shows a retry action that resets a failed queued message to queued', async () => {
    mockContextSendMessage.mockImplementationOnce(async (_request, options) => {
      options?.onError?.(new Error('network down'))
      throw new Error('network down')
    })
    const { result, rerender } = renderQueueableHook()

    await act(async () => {
      await result.current.handleSendMessage()
    })

    isMachineStreamingMock = false
    selectedTaskDetailMock = {
      id: 42,
      status: 'COMPLETED',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail
    rerender()

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: 'network down',
          action: expect.anything(),
        })
      )
    })
    expect(mockToast).toHaveBeenCalledTimes(1)

    const toastAction = mockToast.mock.calls[0][0].action as React.ReactElement<{
      onClick: () => void
    }>
    await act(async () => {
      toastAction.props.onClick()
      await Promise.resolve()
    })

    expect(mockUpdateUserMessage).toHaveBeenCalledWith('local-user-1', {
      status: 'pending',
      queued: true,
      queueStatus: 'queued',
      error: undefined,
    })
  })
})
