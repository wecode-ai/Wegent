// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'

import { useMessageSyncer } from '@/features/tasks/session/messageSyncer'
import type { TaskStateMachine } from '@wegent/chat-core'

const sendChatMessage = jest.fn()
const joinTask = jest.fn()

const socketContext = {
  isConnected: false,
  sendChatMessage,
  cancelChatStream: jest.fn(),
  registerChatHandlers: jest.fn(() => jest.fn()),
  registerSkillHandlers: jest.fn(() => jest.fn()),
  sendSkillResponse: jest.fn(),
  joinTask,
  leaveTask: jest.fn(),
  ensureConnected: jest.fn(),
}

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => socketContext,
}))

describe('useMessageSyncer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the live socket transport when the React connection snapshot is stale', async () => {
    sendChatMessage.mockResolvedValue({
      task_id: 43,
      subtask_id: 46,
      message_id: 3,
    })
    joinTask.mockResolvedValue({})

    const machine = {
      addUserMessage: jest.fn(),
      updateUserMessage: jest.fn(),
      markSendAccepted: jest.fn(),
      renameTaskId: jest.fn(),
    } as unknown as TaskStateMachine
    const ensureMachine = jest.fn(() => machine)
    const onTaskIdResolved = jest.fn()
    const { result } = renderHook(() =>
      useMessageSyncer({
        getMachine: () => machine,
        ensureMachine,
        onTaskIdResolved,
      })
    )

    let taskId: number | undefined
    await act(async () => {
      taskId = await result.current.sendMessage({
        task_id: 43,
        team_id: 99,
        message: 'continue with the selected document',
      })
    })

    expect(taskId).toBe(43)
    expect(sendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 43,
        team_id: 99,
        message: 'continue with the selected document',
      })
    )
    expect(machine.markSendAccepted).toHaveBeenCalledTimes(1)
    expect(joinTask).toHaveBeenCalledWith(43)
  })
})
