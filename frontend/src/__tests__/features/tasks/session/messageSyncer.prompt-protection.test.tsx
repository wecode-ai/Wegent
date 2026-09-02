// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'

import type { TaskStateMachine } from '@wegent/chat-core'
import type { ChatEventHandlers } from '@/contexts/SocketContext'
import { useMessageSyncer } from '@/features/tasks/session/messageSyncer'
import { PROMPT_PROTECTION_BLOCKED_ERROR_TYPE } from '@/types/socket'

const mockUseSocket = jest.fn()

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => mockUseSocket(),
}))

describe('useMessageSyncer prompt protection', () => {
  it('recovers only after a prompt-protection error projection', () => {
    const blockedMessage = '该请求无法处理，请调整问题后再试。'
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    let handlers: ChatEventHandlers | undefined
    const registerChatHandlers = jest.fn((value: ChatEventHandlers) => {
      handlers = value
      return jest.fn()
    })
    mockUseSocket.mockReturnValue({
      isConnected: true,
      sendChatMessage: jest.fn(),
      cancelChatStream: jest.fn(),
      registerChatHandlers,
      registerSkillHandlers: jest.fn(() => jest.fn()),
      sendSkillResponse: jest.fn(),
      joinTask: jest.fn(),
      leaveTask: jest.fn(),
      ensureConnected: jest.fn(),
    })
    const machine = {
      getState: () => ({ taskId: 1122 }),
      handleChatError: jest.fn(),
      recover: jest.fn().mockResolvedValue(undefined),
    }

    renderHook(() =>
      useMessageSyncer({
        getMachine: () => machine as unknown as TaskStateMachine,
        ensureMachine: () => machine as unknown as TaskStateMachine,
        onTaskIdResolved: jest.fn(),
      })
    )

    act(() => {
      handlers?.onChatError?.({
        task_id: 1122,
        subtask_id: 1734,
        message_id: 7,
        error: blockedMessage,
        type: PROMPT_PROTECTION_BLOCKED_ERROR_TYPE,
      })
    })

    expect(machine.handleChatError).toHaveBeenCalledWith(
      1734,
      blockedMessage,
      7,
      PROMPT_PROTECTION_BLOCKED_ERROR_TYPE,
      { allowTerminalMessageUpdate: true }
    )
    expect(machine.recover).not.toHaveBeenCalled()

    machine.recover.mockClear()
    act(() => {
      handlers?.onChatError?.({
        task_id: 1122,
        subtask_id: 1734,
        message_id: 7,
        error: 'provider unavailable',
        type: 'provider_error',
      })
    })
    expect(machine.recover).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })
})
