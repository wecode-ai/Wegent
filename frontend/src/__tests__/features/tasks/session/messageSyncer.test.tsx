// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'

import { useMessageSyncer } from '@/features/tasks/session/messageSyncer'
import { TaskStateMachine } from '@wegent/chat-core'
import type { ChatEventHandlers } from '@/contexts/SocketContext'

const sendChatMessage = jest.fn()
const joinTask = jest.fn()

const socketContext = {
  isConnected: false,
  sendChatMessage,
  cancelChatStream: jest.fn(),
  registerChatHandlers: jest.fn((_handlers: ChatEventHandlers) => jest.fn()),
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

  it('renders declared artifacts from chat done through the canonical message state', () => {
    const machine = new TaskStateMachine(43, {
      joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
      isConnected: () => true,
    })
    const contexts = [
      {
        id: 9,
        context_type: 'remote_workspace_artifact' as const,
        name: 'report.txt',
        status: 'ready' as const,
        remote_task_id: 43,
        remote_path: 'outputs/report.txt',
      },
    ]
    renderHook(() =>
      useMessageSyncer({
        getMachine: () => machine,
        ensureMachine: () => machine,
        onTaskIdResolved: jest.fn(),
      })
    )
    const handlers = socketContext.registerChatHandlers.mock.calls[0][0] as ChatEventHandlers

    act(() => {
      handlers.onChatStart?.({ task_id: 43, subtask_id: 46, message_id: 3 })
      handlers.onChatDone?.({
        task_id: 43,
        subtask_id: 46,
        message_id: 3,
        offset: 4,
        result: { value: 'Done' },
        contexts,
      })
    })

    expect(machine.getState().messages.get('ai-46')).toMatchObject({
      status: 'completed',
      content: 'Done',
      contexts,
    })
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
