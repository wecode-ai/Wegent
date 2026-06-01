// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { render } from '@testing-library/react'
import { useUnifiedMessages } from '@/features/tasks/hooks/useUnifiedMessages'
import type { DisplayMessage } from '@/features/tasks/hooks/useUnifiedMessages'

let mockSelectedTask: { id: number } | null = null
let mockSelectedTaskDetail: { id: number } | null = { id: 42 }
let mockMessages = new Map()
let latestMessages: {
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingSubtaskIds: number[]
} | null = null

const useTaskStateMachineMock = jest.fn((_taskId?: unknown, _syncOptions?: unknown) => ({
  messages: mockMessages,
  isStreaming: false,
}))

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    selectedTask: mockSelectedTask,
    selectedTaskDetail: mockSelectedTaskDetail,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1, user_name: 'tester' },
  }),
}))

jest.mock('@/features/tasks/hooks/useTaskStateMachine', () => ({
  useTaskStateMachine: (taskId: unknown, syncOptions: unknown) =>
    useTaskStateMachineMock(taskId, syncOptions),
}))

function Probe() {
  latestMessages = useUnifiedMessages({
    team: null,
    isGroupChat: false,
  })

  return null
}

describe('useUnifiedMessages', () => {
  beforeEach(() => {
    mockSelectedTask = null
    mockSelectedTaskDetail = { id: 42 }
    mockMessages = new Map()
    latestMessages = null
    useTaskStateMachineMock.mockClear()
  })

  it('uses the selected task detail id for the state machine subscription', () => {
    render(<Probe />)

    expect(useTaskStateMachineMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        currentUserId: 1,
        currentUserName: 'tester',
      })
    )
  })

  it('uses selectedTask while task detail is still loading', () => {
    mockSelectedTask = { id: 99 }
    mockSelectedTaskDetail = null

    render(<Probe />)

    expect(useTaskStateMachineMock).toHaveBeenCalledWith(99, expect.any(Object))
  })

  it('adapts state machine messages for display without owning recovery', () => {
    mockMessages = new Map([
      [
        'user-1',
        {
          id: 'user-1',
          type: 'user',
          status: 'completed',
          content: 'question',
          timestamp: 1,
        },
      ],
      [
        'ai-5',
        {
          id: 'ai-5',
          type: 'ai',
          status: 'streaming',
          content: 'answer',
          timestamp: 2,
          subtaskId: 5,
        },
      ],
    ])
    useTaskStateMachineMock.mockReturnValueOnce({
      messages: mockMessages,
      isStreaming: false,
    })

    render(<Probe />)

    expect(latestMessages?.messages.map(message => message.content)).toEqual(['question', 'answer'])
    expect(latestMessages?.isStreaming).toBe(true)
    expect(latestMessages?.streamingSubtaskIds).toEqual([5])
  })
})
