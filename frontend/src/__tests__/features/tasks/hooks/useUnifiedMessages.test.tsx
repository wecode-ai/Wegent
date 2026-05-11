// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { useUnifiedMessages } from '@/features/tasks/hooks/useUnifiedMessages'

const recoverMock = jest.fn(() => Promise.resolve())

let socketConnected = false

jest.mock('@/features/tasks/contexts/taskContext', () => ({
  useTaskContext: () => ({
    selectedTaskDetail: { id: 42 },
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { id: 1, user_name: 'tester' },
  }),
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    isConnected: socketConnected,
  }),
}))

jest.mock('@/features/tasks/hooks/useTaskStateMachine', () => ({
  useTaskStateMachine: () => ({
    messages: new Map(),
    isStreaming: false,
    recover: recoverMock,
    isInitialized: true,
  }),
}))

function Probe() {
  useUnifiedMessages({
    team: null,
    isGroupChat: false,
  })

  return null
}

describe('useUnifiedMessages', () => {
  beforeEach(() => {
    socketConnected = false
    recoverMock.mockClear()
  })

  it('waits for the socket connection before recovering task messages', async () => {
    const { rerender } = render(<Probe />)

    expect(recoverMock).not.toHaveBeenCalled()

    socketConnected = true
    rerender(<Probe />)

    await waitFor(() => {
      expect(recoverMock).toHaveBeenCalledTimes(1)
    })
  })
})
