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
const mockSendChatGuidance = jest.fn().mockResolvedValue({ success: true })

let isMachineStreamingMock = true
let taskInputMessageMock = 'next question'
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

jest.mock('@/features/projects/contexts/projectContext', () => ({
  useProjectContext: () => ({
    projects: [],
    projectTaskIds: new Set(),
    refreshProjects: jest.fn(),
    isWorkspaceEnabled: false,
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
  useSocket: () => ({
    retryMessage: jest.fn(),
    sendChatGuidance: mockSendChatGuidance,
    registerChatHandlers: jest.fn(() => jest.fn()),
  }),
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
    state: { messages: new Map(), isStopping: false, streamingInfo: { subtask_id: 77 } },
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
      selectedTeam: { id: 5, name: 'Team', agent_type: 'chat' } as never,
      selectedModel: null,
      forceOverride: false,
      setSelectedModel: jest.fn(),
      setForceOverride: jest.fn(),
      selectedRepo: null,
      selectedBranch: null,
      showRepositorySelector: false,
      effectiveRequiresWorkspace: false,
      taskInputMessage: taskInputMessageMock,
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
    taskInputMessageMock = 'next question'
    selectedTaskDetailMock = {
      id: 42,
      status: 'RUNNING',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail
    mockSendChatGuidance.mockResolvedValue({ success: true })
  })

  it('queues a follow-up outside the chat message stream while the active task is streaming', async () => {
    const { result } = renderQueueableHook()

    await act(async () => {
      await result.current.handleSendMessage()
    })

    expect(mockContextSendMessage).not.toHaveBeenCalled()
    expect(mockAddUserMessage).not.toHaveBeenCalled()
    expect(result.current.queuedMessages).toEqual([
      expect.objectContaining({
        id: '42:local-user-1',
        displayMessage: 'next question',
        status: 'queued',
      }),
    ])
    expect(mockSetTaskInputMessage).toHaveBeenCalledWith('')
    expect(mockResetAttachment).toHaveBeenCalled()
    expect(mockResetContexts).toHaveBeenCalled()
  })

  it('returns a cancelled queued follow-up to the input before it is dispatched', async () => {
    const { result, rerender } = renderQueueableHook()

    await act(async () => {
      await result.current.handleSendMessage()
    })

    mockSetTaskInputMessage.mockClear()
    taskInputMessageMock = ''
    rerender()

    act(() => {
      result.current.cancelQueuedMessage('42:local-user-1')
    })

    expect(result.current.queuedMessages).toEqual([])
    expect(mockSetTaskInputMessage).toHaveBeenCalledWith('next question')

    isMachineStreamingMock = false
    selectedTaskDetailMock = {
      id: 42,
      status: 'COMPLETED',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail
    rerender()

    await Promise.resolve()
    expect(mockContextSendMessage).not.toHaveBeenCalled()
  })

  it('merges a new queued input into the existing queued message and sends once', async () => {
    taskInputMessageMock = 'first question'
    const { result, rerender } = renderQueueableHook()

    await act(async () => {
      await result.current.handleSendMessage()
    })

    taskInputMessageMock = 'second question'
    rerender()

    await act(async () => {
      await result.current.handleSendMessage()
    })

    expect(result.current.queuedMessages).toEqual([
      expect.objectContaining({
        displayMessage: 'first question\n\nsecond question',
        status: 'queued',
      }),
    ])
    expect(mockContextSendMessage).not.toHaveBeenCalled()

    isMachineStreamingMock = false
    selectedTaskDetailMock = {
      id: 42,
      status: 'COMPLETED',
      is_group_chat: false,
      subtasks: [],
    } as unknown as TaskDetail
    rerender()

    await waitFor(() => {
      expect(mockContextSendMessage).toHaveBeenCalledTimes(1)
    })
    expect(mockContextSendMessage.mock.calls[0][0]).toMatchObject({
      message: 'first question\n\nsecond question',
    })
    expect(mockContextSendMessage.mock.calls[0][1]).toMatchObject({
      pendingUserMessage: 'first question\n\nsecond question',
    })
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

  it('shows a retry action that resends a failed queued message', async () => {
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
    expect(result.current.queuedMessages[0]).toMatchObject({
      status: 'failed',
      error: 'network down',
    })

    const toastAction = mockToast.mock.calls[0][0].action as React.ReactElement<{
      onClick: () => void
    }>
    await act(async () => {
      toastAction.props.onClick()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockContextSendMessage).toHaveBeenCalledTimes(2)
    })
    expect(mockUpdateUserMessage).not.toHaveBeenCalled()
  })

  it('sends Chat Shell guidance during an active stream', async () => {
    taskInputMessageMock = 'steer the current answer'
    const { result } = renderQueueableHook()

    expect(result.current.canSendGuidance).toBe(true)

    await act(async () => {
      await result.current.handleSendGuidance()
    })

    expect(mockSendChatGuidance).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 42,
        subtask_id: 77,
        team_id: 5,
        message: 'steer the current answer',
        guidance: 'steer the current answer',
        client_guidance_id: expect.stringMatching(/^guidance-42-/),
      })
    )
    expect(mockSetTaskInputMessage).toHaveBeenCalledWith('')
    expect(result.current.guidanceMessages).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^guidance-42-/),
        displayMessage: 'steer the current answer',
        status: 'queued',
      }),
    ])
  })
})
