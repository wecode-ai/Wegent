// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { render } from '@testing-library/react'
import { useMessagePresenter } from '@/features/tasks/presentation/useMessagePresenter'
import type { DisplayMessage } from '@/features/tasks/presentation/useMessagePresenter'

let mockCurrentTaskId: number | null = 42
let mockMessages = new Map()
let mockIsStreaming = false
const mockSetMessageSyncOptions = jest.fn()
let latestMessages: {
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingSubtaskIds: number[]
} | null = null

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    currentTaskId: mockCurrentTaskId,
    messages: mockMessages,
    isStreaming: mockIsStreaming,
    setMessageSyncOptions: mockSetMessageSyncOptions,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1, user_name: 'tester' },
  }),
}))

function Probe() {
  latestMessages = useMessagePresenter({
    team: null,
    isGroupChat: false,
  })

  return null
}

describe('useMessagePresenter', () => {
  beforeEach(() => {
    mockCurrentTaskId = 42
    mockMessages = new Map()
    mockIsStreaming = false
    latestMessages = null
    mockSetMessageSyncOptions.mockClear()
  })

  it('registers display sync options on the current session', () => {
    render(<Probe />)

    expect(mockSetMessageSyncOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUserId: 1,
        currentUserName: 'tester',
      })
    )
  })

  it('uses currentTaskId while task detail is still loading', () => {
    mockCurrentTaskId = 99
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
    ])

    render(<Probe />)

    expect(latestMessages?.messages.map(message => message.content)).toEqual(['question'])
  })

  it('adapts raw session messages for display without owning recovery', () => {
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
    render(<Probe />)

    expect(latestMessages?.messages.map(message => message.content)).toEqual(['question', 'answer'])
    expect(latestMessages?.isStreaming).toBe(true)
    expect(latestMessages?.streamingSubtaskIds).toEqual([5])
  })
})
