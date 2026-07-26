// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { act, render, screen } from '@testing-library/react'
import MessagesArea, {
  deriveSaveToKnowledgeTitle,
} from '@/features/tasks/components/message/MessagesArea'
import type { DisplayMessage } from '@/features/tasks/presentation/useMessagePresenter'
import type { TaskStateSnapshot } from '@wegent/chat-core'
import type { KnowledgeBaseWithGroupInfo, KnowledgeDocument } from '@/types/knowledge'

const messageBubbleRenderSpy = jest.fn()
const saveToKnowledgeDialogRenderSpy = jest.fn()
const documentDetailDialogRenderSpy = jest.fn()
const mockToast = jest.fn()

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
  taskState: null as TaskStateSnapshot | null,
}

const createTaskStateSnapshot = (
  overrides: Partial<Omit<TaskStateSnapshot, 'runtime' | 'derived'>> & {
    runtime?: Partial<TaskStateSnapshot['runtime']>
    derived?: Partial<TaskStateSnapshot['derived']>
  } = {}
): TaskStateSnapshot => {
  const taskId = overrides.taskId ?? 707
  const base: TaskStateSnapshot = {
    taskId,
    phase: 'ready',
    messages: new Map(),
    error: null,
    isStopping: false,
    runtime: {
      taskId,
      phase: 'unknown',
      joinedRoom: false,
      localStreamCursor: 0,
    },
    derived: {
      isExecutionActive: false,
      isTerminal: false,
      isStreaming: false,
      shouldJoinRoom: false,
      canSendMessage: true,
      canQueueMessage: false,
      canCancelTask: false,
      blocksQueuedDispatch: false,
      serverConfirmedNoStream: false,
    },
  }

  return {
    ...base,
    ...overrides,
    runtime: {
      ...base.runtime,
      ...overrides.runtime,
      taskId: overrides.runtime?.taskId ?? taskId,
    },
    derived: {
      ...base.derived,
      ...overrides.derived,
    },
  }
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
    toast: mockToast,
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

jest.mock('@/features/tasks/components/message/SaveToKnowledgeDialog', () => ({
  SaveToKnowledgeDialog: (props: unknown) => {
    saveToKnowledgeDialogRenderSpy(props)
    return null
  },
}))

jest.mock('@/features/knowledge/document/components/DocumentDetailDialog', () => ({
  DocumentDetailDialog: (props: unknown) => {
    documentDetailDialogRenderSpy(props)
    return null
  },
}))

describe('deriveSaveToKnowledgeTitle', () => {
  it('uses the nearest previous user message first line', () => {
    const messages: DisplayMessage[] = [
      {
        id: 'user-title',
        type: 'user',
        content: '\n  Deployment guide  \nwith details',
        timestamp: 1,
        status: 'completed',
      },
      {
        id: 'ai-answer',
        type: 'ai',
        content: 'answer',
        timestamp: 2,
        status: 'completed',
      },
    ]

    expect(deriveSaveToKnowledgeTitle(messages, 1, 'fallback')).toBe('Deployment guide')
  })
})

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

  it('binds each success toast to the document created by that save', () => {
    render(
      <MessagesArea
        selectedTeam={null}
        selectedRepo={null}
        selectedBranch={null}
        isGroupChat={false}
      />
    )
    const aiBubbleProps = messageBubbleRenderSpy.mock.calls
      .map(call => call[0])
      .find(props => props.msg.type === 'ai') as {
      onSaveToKnowledge: (content: string) => void
    }

    act(() => aiBubbleProps.onSaveToKnowledge('# Answer'))

    const dialogProps = saveToKnowledgeDialogRenderSpy.mock.lastCall?.[0] as {
      onCreated: (document: KnowledgeDocument, knowledgeBase: KnowledgeBaseWithGroupInfo) => void
    }
    const knowledgeBase = {
      id: 7,
      name: 'Knowledge',
      namespace: 'default',
      kb_type: 'notebook',
      group_type: 'personal',
    } as KnowledgeBaseWithGroupInfo
    const documentA = { id: 101, name: 'A' } as KnowledgeDocument
    const documentB = { id: 102, name: 'B' } as KnowledgeDocument

    act(() => {
      dialogProps.onCreated(documentA, knowledgeBase)
      dialogProps.onCreated(documentB, knowledgeBase)
    })
    const firstToastAction = mockToast.mock.calls[0][0].action as React.ReactElement<{
      onClick: () => void
    }>
    documentDetailDialogRenderSpy.mockClear()

    act(() => firstToastAction.props.onClick())

    expect(documentDetailDialogRenderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        document: documentA,
        knowledgeBaseId: knowledgeBase.id,
        open: true,
      })
    )
  })

  it('shows a sync indicator while the current task has no messages yet', () => {
    mockMessages = []
    mockTaskSession = {
      ...mockTaskSession,
      selectedTaskDetail: { id: 707, title: 'Task 707', status: 'RUNNING' },
      taskState: createTaskStateSnapshot({
        taskId: 707,
        phase: 'syncing',
        runtime: {
          phase: 'syncing',
          joinedRoom: true,
          activeStreamSubtaskId: 88,
          recoveryReason: 'task-selected',
        },
        derived: {
          isExecutionActive: true,
          isStreaming: true,
          canQueueMessage: true,
          canCancelTask: true,
          blocksQueuedDispatch: true,
        },
      }),
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
      taskState: createTaskStateSnapshot({
        taskId: 707,
        phase: 'ready',
        runtime: {
          phase: 'terminal',
          joinedRoom: false,
          recoveryReason: 'task-selected',
        },
        derived: {
          isTerminal: true,
        },
      }),
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
