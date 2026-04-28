// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TaskStateMachine } from '@/features/tasks/state'

describe('TaskStateMachine', () => {
  it('refreshes timestamp when the same AI message receives a new chat:error event', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)

    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleChatStart(42, 'Chat', 7)

    const beforeError = machine.getState().messages.get('ai-42')
    expect(beforeError).toBeDefined()

    machine.handleChatError(42, 'first retry failed', 7, 'model_unavailable')

    const afterError = machine.getState().messages.get('ai-42')
    expect(afterError).toBeDefined()
    expect(afterError?.status).toBe('error')
    expect(afterError?.errorType).toBe('model_unavailable')
    expect(afterError?.timestamp).toBeGreaterThan(beforeError?.timestamp ?? 0)

    nowSpy.mockRestore()
  })
})
