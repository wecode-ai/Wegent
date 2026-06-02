// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { act, render, screen } from '@testing-library/react'
import MessagesArea from '@/features/tasks/components/message/MessagesArea'
import type { DisplayMessage } from '@/features/tasks/presentation/useMessagePresenter'

const messageBubbleRenderSpy = jest.fn()

let mockMessages: DisplayMessage[] = [
  {
    id: 'user-1',
    type: 'user',
    content: 'hello',
    timestamp: Date.now(),
    status: 'completed',
    subtaskId: 1,
  },
  {
    id: 'ai-1',
    type: 'ai',
    content: 'world',
    timestamp: Date.now() + 1,
    status: 'completed',
    subtaskId: 2,
  },
]
let mockStreamingSubtaskIds: number[] = []
let mockPresentedIsStreaming = false
let mockTaskSession = {
  selectedTaskDetail: null as { id: number; title: string; status: string } | null,
  refreshSelectedTaskDetail: jest.fn(),
  refreshTasks: jest.fn(),
  selectTask: jest.fn(),
  cleanupMessagesAfterEdit: jest.fn(),
  taskState: null as {
    taskId: number
    status: string
    error?: string | null
    runtime?: {
      phase?: string
      joinedRoom?: boolean
      activeStreamSubtaskId?: number | null
      recoveryReason?: string
      recoveryError?: string
    }
  } | null,
}

jest.mock('@/features/tasks/components/message/MessageBubble', () => ({
  __esModule: true,
  default: (props: unknown) => {
    messageBubbleRenderSpy(props)
    return <div data-testid="message-bubble" />
  },
}))

jest.mock('@/features/tasks/presentation/useMessagePresenter', () => ({
  useMessagePresenter: () => ({
    messages: mockMessages,
    streamingSubtaskIds: mockStreamingSubtaskIds,
    isStreaming: mockPresentedIsStreaming,
  }),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => mockTaskSession,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1, user_name: 'tester' },
  }),
}))

jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({
    traceAction: async (_name: string, _attrs: unknown, fn: () => Promise<void>) => fn(),
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    registerCorrectionHandlers: () => () => {},
  }),
}))

jest.mock('@/features/tasks/components/share/TaskShareModal', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/share/ExportSelectModal', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/group-chat', () => ({
  TaskMembersPanel: () => null,
}))

jest.mock('@/features/tasks/components/CorrectionProgressIndicator', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/tasks/components/CorrectionResultPanel', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/features/inbox/components/ForwardMessageDialog', () => ({
  ForwardMessageDialog: () => null,
}))

describe('MessagesArea memoization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMessages = [
      {
        id: 'user-1',
        type: 'user',
        content: 'hello',
        timestamp: Date.now(),
        status: 'completed',
        subtaskId: 1,
      },
      {
        id: 'ai-1',
        type: 'ai',
        content: 'world',
        timestamp: Date.now() + 1,
        status: 'completed',
        subtaskId: 2,
      },
    ]
    mockStreamingSubtaskIds = []
    mockPresentedIsStreaming = false
    mockTaskSession = {
      selectedTaskDetail: null,
      refreshSelectedTaskDetail: jest.fn(),
      refreshTasks: jest.fn(),
      selectTask: jest.fn(),
      cleanupMessagesAfterEdit: jest.fn(),
      taskState: null,
    }
  })

  it('does not re-render message bubbles when parent re-renders with identical props', () => {
    const props = {
      selectedTeam: null,
      selectedRepo: null,
      selectedBranch: null,
      isGroupChat: false,
    }

    const { rerender } = render(<MessagesArea {...props} />)
    const firstRenderCount = messageBubbleRenderSpy.mock.calls.length

    rerender(<MessagesArea {...props} />)

    expect(messageBubbleRenderSpy).toHaveBeenCalledTimes(firstRenderCount)
  })

  it('shows a sync indicator while the current task has no messages yet', () => {
    mockMessages = []
    mockTaskSession = {
      ...mockTaskSession,
      selectedTaskDetail: { id: 707, title: 'Task 707', status: 'RUNNING' },
      taskState: {
        taskId: 707,
        status: 'syncing',
        runtime: {
          phase: 'syncing',
          joinedRoom: true,
          activeStreamSubtaskId: 88,
          recoveryReason: 'task-selected',
        },
      },
    }

    render(
      <MessagesArea
        selectedTeam={null}
        selectedRepo={null}
        selectedBranch={null}
        isGroupChat={false}
        hasMessages
      />
    )

    expect(screen.getByTestId('messages-syncing-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('messages-syncing-animation')).toBeInTheDocument()
    expect(screen.queryByTestId('task-runtime-watermark')).not.toBeInTheDocument()
  })

  it('shows runtime glyph only for an empty non-loading message area', () => {
    jest.useFakeTimers()
    mockMessages = []
    mockTaskSession = {
      ...mockTaskSession,
      selectedTaskDetail: { id: 707, title: 'Task 707', status: 'COMPLETED' },
      taskState: {
        taskId: 707,
        status: 'ready',
        runtime: {
          phase: 'terminal',
          joinedRoom: false,
          activeStreamSubtaskId: null,
          recoveryReason: 'task-selected',
        },
      },
    }

    render(
      <MessagesArea
        selectedTeam={null}
        selectedRepo={null}
        selectedBranch={null}
        isGroupChat={false}
        hasMessages
      />
    )

    expect(screen.queryByTestId('messages-syncing-indicator')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-runtime-watermark')).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(3000)
    })

    const watermark = screen.getByTestId('task-runtime-watermark')
    expect(watermark).toHaveTextContent('✅')
    expect(watermark).toHaveTextContent('🏁')
    expect(watermark).toHaveTextContent('🚪')
    expect(watermark).toHaveTextContent('🧭')
    expect(watermark).toHaveTextContent('⚪')
    expect(watermark).toHaveTextContent('▫️')
    expect(watermark).toHaveAttribute('data-task-id', '707')
    expect(watermark).toHaveAttribute('data-runtime-code', 's4-p5-r0-q1-e0-m0')
    expect(watermark.querySelectorAll('[data-runtime-symbol]')).toHaveLength(6)
    jest.useRealTimers()
  })
})
