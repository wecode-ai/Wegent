// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { render } from '@testing-library/react'
import MessagesArea from '@/features/tasks/components/message/MessagesArea'
import type { DisplayMessage } from '@/features/tasks/hooks/useUnifiedMessages'

const messageBubbleRenderSpy = jest.fn()

const mockMessages: DisplayMessage[] = [
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

jest.mock('@/features/tasks/components/message/MessageBubble', () => ({
  __esModule: true,
  default: (props: unknown) => {
    messageBubbleRenderSpy(props)
    return <div data-testid="message-bubble" />
  },
}))

jest.mock('@/features/tasks/hooks/useUnifiedMessages', () => ({
  useUnifiedMessages: () => ({
    messages: mockMessages,
    streamingSubtaskIds: [],
    isStreaming: false,
  }),
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    selectedTaskDetail: null,
    refreshSelectedTaskDetail: jest.fn(),
    refreshTasks: jest.fn(),
    setSelectedTask: jest.fn(),
  }),
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

jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  useChatStreamContext: () => ({
    cleanupMessagesAfterEdit: jest.fn(),
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

describe('MessagesArea memoization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
})
