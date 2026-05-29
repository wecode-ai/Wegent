// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TaskStateMachine } from '@/features/tasks/state'

describe('TaskStateMachine', () => {
  it('stores reasoning chunks as chronological thinking blocks', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, '', { reasoning_chunk: 'First thought. ' })
    machine.handleChatChunk(42, '', { reasoning_chunk: 'Still thinking.' })
    machine.handleChatChunk(42, 'First answer.')
    machine.handleChatChunk(42, '', {
      blocks: [
        {
          id: 'tool-1',
          type: 'tool',
          tool_use_id: 'tool-1',
          tool_name: 'Read',
          tool_input: { file_path: 'README.md' },
          status: 'pending',
        },
      ],
    })
    machine.handleChatChunk(42, '', { reasoning_chunk: 'Second thought.' })
    machine.handleChatChunk(42, 'Final answer.')

    const message = machine.getState().messages.get('ai-42')
    const blocks = message?.result?.blocks ?? []

    expect(blocks.map(block => block.type)).toEqual([
      'thinking',
      'text',
      'tool',
      'thinking',
      'text',
    ])
    expect(blocks[0]).toMatchObject({
      type: 'thinking',
      content: 'First thought. Still thinking.',
      status: 'done',
    })
    expect(blocks[1]).toMatchObject({
      type: 'text',
      content: 'First answer.',
      status: 'done',
    })
    expect(blocks[3]).toMatchObject({
      type: 'thinking',
      content: 'Second thought.',
      status: 'done',
    })
    expect(blocks[4]).toMatchObject({
      type: 'text',
      content: 'Final answer.',
      status: 'streaming',
    })
  })

  it('preserves new done text blocks when inline thinking blocks exist', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, '', { reasoning_chunk: 'Thought.' })
    machine.handleChatChunk(42, 'First answer.')
    machine.handleChatDone(42, 'First answer. Late answer.', {
      blocks: [
        {
          id: 'done-duplicate-text',
          type: 'text',
          content: 'First answer.',
          status: 'done',
        },
        {
          id: 'done-late-text',
          type: 'text',
          content: 'Late answer.',
          status: 'done',
        },
      ],
    })

    const message = machine.getState().messages.get('ai-42')
    const blocks = message?.result?.blocks ?? []

    expect(blocks.map(block => block.type)).toEqual(['thinking', 'text', 'text'])
    expect(
      blocks.map(block => (block.type === 'text' || block.type === 'thinking' ? block.content : ''))
    ).toEqual(['Thought.', 'First answer.', 'Late answer.'])
    expect(blocks.every(block => block.status === 'done')).toBe(true)
  })

  it('finalizes streaming blocks on chat done without event result', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, '', { reasoning_chunk: 'Thought.' })
    machine.handleChatChunk(42, 'Final answer.')
    machine.handleChatDone(42, 'Final answer.')

    const message = machine.getState().messages.get('ai-42')
    const blocks = message?.result?.blocks ?? []

    expect(blocks.map(block => block.type)).toEqual(['thinking', 'text'])
    expect(blocks.every(block => block.status === 'done')).toBe(true)
  })

  it('does not debounce a recovery that exits before the socket is connected', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000)
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const joinTask = jest.fn().mockResolvedValue({ subtasks: [] })
    let connected = false

    const machine = new TaskStateMachine(100, {
      joinTask,
      isConnected: () => connected,
    })

    await machine.recover()
    expect(joinTask).not.toHaveBeenCalled()

    connected = true
    await machine.recover()

    expect(joinTask).toHaveBeenCalledTimes(1)
    expect(joinTask).toHaveBeenCalledWith(100, {
      forceRefresh: true,
      afterMessageId: undefined,
    })

    nowSpy.mockRestore()
    consoleInfoSpy.mockRestore()
  })

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
