// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TaskStateMachine, type TaskStateMachineDeps } from '@/features/tasks/state'

function createRuntimeActions(overrides: Partial<TaskStateMachineDeps> = {}): TaskStateMachineDeps {
  return {
    joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
    pullRuntime: jest.fn().mockResolvedValue({
      task_id: 42,
      task_status: 'COMPLETED',
      status_updated_at: '2026-06-01T10:00:00',
      active_stream: null,
    }),
    isConnected: jest.fn(() => true),
    ...overrides,
  }
}

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

  it('keeps pending socket recovery when terminal task detail arrives before socket connect', async () => {
    const joinTask = jest.fn().mockResolvedValue({ subtasks: [] })
    const pullRuntime = jest.fn().mockResolvedValue({
      task_id: 100,
      task_status: 'COMPLETED',
      status_updated_at: '2026-06-01T10:00:00.000Z',
      active_stream: null,
    })
    let connected = false

    const machine = new TaskStateMachine(100, {
      joinTask,
      pullRuntime,
      isConnected: () => connected,
    })

    await machine.recover({ force: true, reason: 'task-selected' })
    expect(machine.getState().phase).toBe('waiting_socket')

    machine.loadTask({
      id: 100,
      status: 'COMPLETED',
      updated_at: '2026-06-01T10:00:00.000Z',
    })

    expect(machine.getState().phase).toBe('waiting_socket')
    expect(joinTask).not.toHaveBeenCalled()

    connected = true
    await machine.handleSocketConnected('websocket-reconnect')

    expect(pullRuntime).toHaveBeenCalledWith(100)
    expect(joinTask).toHaveBeenCalledWith(100, {
      forceRefresh: true,
      afterMessageId: undefined,
    })
  })

  it('checks runtime before resolving pending socket recovery on reconnect', async () => {
    const joinTask = jest.fn().mockResolvedValue({ subtasks: [] })
    const pullRuntime = jest.fn().mockResolvedValue({
      task_id: 100,
      task_status: 'RUNNING',
      active_stream: {
        subtask_id: 77,
        cursor: 12,
      },
    })
    let connected = false

    const machine = new TaskStateMachine(100, {
      joinTask,
      pullRuntime,
      isConnected: () => connected,
    })

    await machine.recover({ force: true, reason: 'task-selected' })
    expect(machine.getState().phase).toBe('waiting_socket')

    connected = true
    await machine.handleSocketConnected('websocket-reconnect')

    expect(pullRuntime).toHaveBeenCalledWith(100)
    expect(joinTask).toHaveBeenCalledWith(100, {
      forceRefresh: true,
      afterMessageId: undefined,
      resumeFromCursor: 0,
      activeStreamSubtaskId: 77,
    })
  })

  it('requires pullRuntime when resolving pending socket recovery on reconnect', async () => {
    const joinTask = jest.fn().mockResolvedValue({ subtasks: [] })
    let connected = false

    const machine = new TaskStateMachine(100, {
      joinTask,
      isConnected: () => connected,
    })

    await machine.recover({ force: true, reason: 'task-selected' })
    expect(machine.getState().phase).toBe('waiting_socket')

    connected = true

    await expect(machine.handleSocketConnected('websocket-reconnect')).rejects.toThrow(
      '[TaskStateMachine] pullRuntime action is required for checkHealth().'
    )
    expect(joinTask).not.toHaveBeenCalled()
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

  it('enters running runtime phase and requests room join for active task status', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING', '2026-05-31T10:00:00.000Z')

    const state = machine.getState()
    expect(state.runtime).toMatchObject({
      taskId: 100,
      taskStatus: 'RUNNING',
      phase: 'running',
      joinedRoom: false,
      lastStatusUpdatedAt: '2026-05-31T10:00:00.000Z',
    })
    expect(state.derived).toMatchObject({
      isExecutionActive: true,
      isTerminal: false,
      shouldJoinRoom: true,
      blocksQueuedDispatch: true,
    })
  })

  it('marks runtime as streaming when chat starts for an active task', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)

    const state = machine.getState()
    expect(state.runtime.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(42)
    expect(state.derived.isStreaming).toBe(true)
    expect(state.derived.canQueueMessage).toBe(true)
  })

  it('marks runtime as running when a send is accepted before chat start', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.markSendAccepted('2026-05-31T10:00:00.000Z')

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime).toMatchObject({
      taskId: 100,
      taskStatus: 'RUNNING',
      phase: 'running',
      lastStatusUpdatedAt: '2026-05-31T10:00:00.000Z',
    })
    expect(state.derived).toMatchObject({
      isExecutionActive: true,
      blocksQueuedDispatch: true,
      canCancelTask: true,
    })
  })

  it('send accepted clears old terminal markers for follow-up sends', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:00:00.000Z')
    machine.markSendAccepted('2026-05-31T10:01:00.000Z')
    machine.syncTaskDetail({
      id: 100,
      status: 'COMPLETED',
      updated_at: '2026-05-31T10:00:00.000Z',
    })

    const state = machine.getState()
    expect(state.runtime.taskStatus).toBe('RUNNING')
    expect(state.runtime.phase).toBe('running')
    expect(state.runtime.hasTerminalStatus).toBe(false)
    expect(state.runtime.lastTerminalStatusUpdatedAt).toBeUndefined()
    expect(state.derived.isTerminal).toBe(false)
  })

  it('terminal task status clears streaming runtime and unblocks queued dispatch', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.setStopping(true)
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')

    const state = machine.getState()
    const message = state.messages.get('ai-42')
    expect(state.phase).toBe('ready')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.isStopping).toBe(false)
    expect(state.runtime).toMatchObject({
      taskStatus: 'COMPLETED',
      phase: 'terminal',
      activeStreamSubtaskId: undefined,
    })
    expect(state.derived).toMatchObject({
      isTerminal: true,
      blocksQueuedDispatch: false,
      canSendMessage: true,
    })
    expect(message?.status).toBe('completed')
    expect(message?.subtaskStatus).toBe('COMPLETED')
  })

  it('terminal task status discards pending chunks from a stale stream', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const joinTask = jest.fn().mockResolvedValue({
      subtasks: [
        {
          id: 42,
          task_id: 100,
          team_id: 1,
          title: 'done',
          bot_ids: [],
          role: 'TEAM',
          message_id: 7,
          parent_id: 0,
          prompt: '',
          executor_namespace: '',
          executor_name: '',
          status: 'COMPLETED',
          progress: 100,
          batch: 0,
          result: { value: 'done' },
          error_message: '',
          user_id: 1,
          created_at: '2026-05-31T10:00:00.000Z',
          updated_at: '2026-05-31T10:00:00.000Z',
          completed_at: '2026-05-31T10:00:00.000Z',
          bots: [],
        },
      ],
    })
    const machine = new TaskStateMachine(100, {
      joinTask,
      isConnected: () => true,
    })

    machine.handleChatChunk(42, ' stale')
    machine.handleTaskStatus('COMPLETED')
    await machine.recover({ force: true })

    const message = machine.getState().messages.get('ai-42')
    expect(message?.content).toBe('done')
    expect(message?.status).toBe('completed')

    consoleInfoSpy.mockRestore()
  })

  it('syncs join subtasks when task detail marks the task terminal before join ack returns', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    let resolveJoin: (value: {
      subtasks: Array<Record<string, unknown>>
      streaming?: undefined
    }) => void = () => {}
    const joinTask = jest.fn(
      () =>
        new Promise<{ subtasks: Array<Record<string, unknown>>; streaming?: undefined }>(
          resolve => {
            resolveJoin = resolve
          }
        )
    )

    const machine = new TaskStateMachine(100, {
      joinTask,
      isConnected: () => true,
    })

    const recoverPromise = machine.recover({ force: true, reason: 'task-selected' })

    machine.syncTaskDetail({
      id: 100,
      status: 'COMPLETED',
      updated_at: '2026-05-31T10:01:00.000Z',
    })

    resolveJoin({
      subtasks: [
        {
          id: 42,
          task_id: 100,
          team_id: 1,
          title: 'done',
          bot_ids: [],
          role: 'TEAM',
          message_id: 7,
          parent_id: 0,
          prompt: '',
          executor_namespace: '',
          executor_name: '',
          status: 'COMPLETED',
          progress: 100,
          batch: 0,
          result: { value: 'done' },
          error_message: '',
          user_id: 1,
          created_at: '2026-05-31T10:00:00.000Z',
          updated_at: '2026-05-31T10:00:00.000Z',
          completed_at: '2026-05-31T10:01:00.000Z',
          bots: [],
        },
      ],
    })

    await recoverPromise

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.joinedRoom).toBe(true)
    expect(state.messages.get('ai-42')?.content).toBe('done')

    consoleInfoSpy.mockRestore()
  })

  it('ignores stale lifecycle updates after a newer terminal status', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.syncTaskDetail({
      id: 100,
      status: 'RUNNING',
      updated_at: '2026-05-31T10:00:00.000Z',
    })

    const state = machine.getState()
    expect(state.runtime.taskStatus).toBe('COMPLETED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.derived.blocksQueuedDispatch).toBe(false)
  })

  it('ignores active lifecycle snapshots after an untimestamped terminal status', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED')
    machine.syncTaskDetail({
      id: 100,
      status: 'RUNNING',
      updated_at: '2026-05-31T10:00:00.000Z',
    })

    const state = machine.getState()
    expect(state.runtime.taskStatus).toBe('COMPLETED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.derived.blocksQueuedDispatch).toBe(false)
  })

  it('uses later chat done content when terminal status arrived first', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, 'partial')
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatDone(42, 'partial final')

    const state = machine.getState()
    const message = state.messages.get('ai-42')
    expect(state.runtime.phase).toBe('terminal')
    expect(message?.content).toBe('partial final')
    expect(message?.status).toBe('completed')
  })

  it('keeps failed terminal status authoritative when chat done arrives late', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, 'partial')
    machine.handleTaskStatus('FAILED', '2026-05-31T10:01:00.000Z')
    machine.handleChatDone(42, 'partial final')

    const message = machine.getState().messages.get('ai-42')
    expect(message?.status).toBe('error')
    expect(message?.subtaskStatus).toBe('FAILED')
  })

  it('keeps completed terminal status authoritative when chat error arrives late', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, 'done')
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatError(42, 'late error', 7, 'transport')

    const message = machine.getState().messages.get('ai-42')
    expect(message?.status).toBe('completed')
    expect(message?.subtaskStatus).toBe('COMPLETED')
    expect(message?.error).toBeUndefined()
  })

  it('keeps completed terminal status authoritative when chat cancelled arrives late', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, 'done')
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatCancelled(42)

    const message = machine.getState().messages.get('ai-42')
    expect(message?.status).toBe('completed')
    expect(message?.subtaskStatus).toBe('COMPLETED')
  })

  it('updates completed backend content after terminal status finalized a partial stream', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const joinTask = jest.fn().mockResolvedValue({
      subtasks: [
        {
          id: 42,
          task_id: 100,
          team_id: 1,
          title: 'done',
          bot_ids: [],
          role: 'TEAM',
          message_id: 7,
          parent_id: 0,
          prompt: '',
          executor_namespace: '',
          executor_name: '',
          status: 'COMPLETED',
          progress: 100,
          batch: 0,
          result: { value: 'partial final from backend' },
          error_message: '',
          user_id: 1,
          created_at: '2026-05-31T10:00:00.000Z',
          updated_at: '2026-05-31T10:00:00.000Z',
          completed_at: '2026-05-31T10:00:00.000Z',
          bots: [],
        },
      ],
    })
    const machine = new TaskStateMachine(100, {
      joinTask,
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, 'partial')
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    await machine.recover({ force: true })

    const message = machine.getState().messages.get('ai-42')
    expect(message?.content).toBe('partial final from backend')
    expect(message?.status).toBe('completed')

    consoleInfoSpy.mockRestore()
  })

  it('does not mark existing streaming message completed from a pending backend snapshot', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const joinTask = jest.fn().mockResolvedValue({
      subtasks: [
        {
          id: 42,
          task_id: 100,
          team_id: 1,
          title: 'pending',
          bot_ids: [],
          role: 'TEAM',
          message_id: 7,
          parent_id: 0,
          prompt: '',
          executor_namespace: '',
          executor_name: '',
          status: 'PENDING',
          progress: 0,
          batch: 0,
          result: {},
          error_message: '',
          user_id: 1,
          created_at: '2026-05-31T10:00:00.000Z',
          updated_at: '2026-05-31T10:00:00.000Z',
          completed_at: '',
          bots: [],
        },
      ],
    })
    const machine = new TaskStateMachine(100, {
      joinTask,
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatChunk(42, 'partial')
    await machine.recover({ force: true })

    const state = machine.getState()
    const message = state.messages.get('ai-42')
    expect(state.phase).toBe('streaming')
    expect(state.runtime.phase).toBe('streaming')
    expect(message?.status).toBe('streaming')
    expect(message?.content).toBe('partial')

    consoleInfoSpy.mockRestore()
  })

  it('ignores duplicate chat start for an already finalized terminal message', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(42, 'Chat', 7)

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.derived.isTerminal).toBe(true)
    expect(state.derived.isStreaming).toBe(false)
    expect(state.derived.canQueueMessage).toBe(false)
    expect(state.messages.get('ai-42')?.status).toBe('completed')
  })

  it('allows a new chat start after terminal lifecycle status for follow-up sends', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(43, 'Chat', 8)

    const state = machine.getState()
    expect(state.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.runtime.taskStatus).toBe('RUNNING')
    expect(state.runtime.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.derived.isTerminal).toBe(false)
    expect(state.derived.isStreaming).toBe(true)
    expect(state.derived.canQueueMessage).toBe(true)
  })

  it('ignores old terminal snapshots after a follow-up chat start', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(43, 'Chat', 8)
    machine.syncTaskDetail({
      id: 100,
      status: 'COMPLETED',
      updated_at: '2026-05-31T10:01:00.000Z',
    })

    const state = machine.getState()
    expect(state.phase).toBe('streaming')
    expect(state.runtime.taskStatus).toBe('RUNNING')
    expect(state.runtime.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
  })

  it('ignores old terminal snapshots after an untimestamped terminal and follow-up chat start', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED')
    machine.handleChatStart(43, 'Chat', 8)
    machine.syncTaskDetail({
      id: 100,
      status: 'COMPLETED',
      updated_at: '2026-05-31T10:01:00.000Z',
    })

    const state = machine.getState()
    expect(state.phase).toBe('streaming')
    expect(state.runtime.taskStatus).toBe('RUNNING')
    expect(state.runtime.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
  })

  it('applies deferred terminal snapshot when the active follow-up stream ends', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED')
    machine.handleChatStart(43, 'Chat', 8)
    machine.syncTaskDetail({
      id: 100,
      status: 'COMPLETED',
      updated_at: '2026-05-31T10:01:00.000Z',
    })
    machine.handleChatDone(43, 'follow-up done')

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime.taskStatus).toBe('COMPLETED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.derived.isTerminal).toBe(true)
  })

  it('applies deferred terminal snapshot when the active follow-up stream errors', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED')
    machine.handleChatStart(43, 'Chat', 8)
    machine.syncTaskDetail({
      id: 100,
      status: 'FAILED',
      updated_at: '2026-05-31T10:01:00.000Z',
    })
    machine.handleChatError(43, 'follow-up failed', 8, 'transport')

    const state = machine.getState()
    expect(state.phase).toBe('error')
    expect(state.runtime.taskStatus).toBe('FAILED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.derived.isTerminal).toBe(true)
  })

  it('applies deferred terminal snapshot when the active follow-up stream is cancelled', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('COMPLETED')
    machine.handleChatStart(43, 'Chat', 8)
    machine.syncTaskDetail({
      id: 100,
      status: 'CANCELLED',
      updated_at: '2026-05-31T10:01:00.000Z',
    })
    machine.handleChatCancelled(43)

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime.taskStatus).toBe('CANCELLED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.derived.isTerminal).toBe(true)
  })

  it('keeps follow-up stream active when old chat done arrives late', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(43, 'Chat', 8)
    machine.handleChatDone(42, 'old done')

    const state = machine.getState()
    expect(state.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.runtime.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.derived.isStreaming).toBe(true)
  })

  it('keeps old failed message immutable when chat done arrives after follow-up starts', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleTaskStatus('FAILED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(43, 'Chat', 8)
    machine.handleChatDone(42, 'late success')

    const oldMessage = machine.getState().messages.get('ai-42')
    expect(oldMessage?.status).toBe('error')
    expect(oldMessage?.subtaskStatus).toBe('FAILED')
  })

  it('keeps old completed message immutable when late chat done reports an error after follow-up starts', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(43, 'Chat', 8)
    machine.handleChatDone(42, 'late error', undefined, undefined, undefined, true, 'old error')

    const oldMessage = machine.getState().messages.get('ai-42')
    expect(oldMessage?.status).toBe('completed')
    expect(oldMessage?.subtaskStatus).toBe('COMPLETED')
    expect(oldMessage?.error).toBeUndefined()
  })

  it('applies equal-timestamp terminal status for the current active stream', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime.taskStatus).toBe('COMPLETED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
  })

  it('keeps follow-up stream active when old chat error arrives late', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(43, 'Chat', 8)
    machine.handleChatError(42, 'old error', 7, 'transport')

    const state = machine.getState()
    expect(state.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.runtime.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.error).toBeNull()
  })

  it('keeps follow-up stream active when old chat cancelled arrives late', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleTaskStatus('COMPLETED', '2026-05-31T10:01:00.000Z')
    machine.handleChatStart(43, 'Chat', 8)
    machine.handleChatCancelled(42)

    const state = machine.getState()
    expect(state.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.runtime.phase).toBe('streaming')
    expect(state.runtime.activeStreamSubtaskId).toBe(43)
    expect(state.derived.isStreaming).toBe(true)
  })

  it('chat done ends the active stream and completes the task runtime', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatDone(42, 'done')

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime.taskStatus).toBe('COMPLETED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.derived.blocksQueuedDispatch).toBe(false)
    expect(state.derived.canCancelTask).toBe(false)
  })

  it('chat error ends the active stream and fails the task runtime', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatError(42, 'network error', 7, 'transport')

    const state = machine.getState()
    expect(state.phase).toBe('error')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.runtime.taskStatus).toBe('FAILED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.derived.isStreaming).toBe(false)
    expect(state.derived.blocksQueuedDispatch).toBe(false)
    expect(state.derived.canCancelTask).toBe(false)
  })

  it('chat cancelled ends the active stream and cancels the task runtime', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatCancelled(42)

    const state = machine.getState()
    expect(state.phase).toBe('ready')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.runtime.taskStatus).toBe('CANCELLED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.derived.isStreaming).toBe(false)
    expect(state.derived.blocksQueuedDispatch).toBe(false)
    expect(state.derived.canCancelTask).toBe(false)
  })

  it('ignores stale running snapshots after chat done completed the runtime', () => {
    const machine = new TaskStateMachine(100, {
      joinTask: jest.fn(),
      isConnected: () => true,
    })

    machine.handleTaskStatus('RUNNING', '2026-05-31T10:00:00.000Z')
    machine.handleChatStart(42, 'Chat', 7)
    machine.handleChatDone(42, 'done')
    machine.syncTaskDetail({
      id: 100,
      status: 'RUNNING',
      updated_at: '2026-05-31T10:02:00.000Z',
    })

    const state = machine.getState()
    expect(state.runtime.taskStatus).toBe('COMPLETED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.derived.blocksQueuedDispatch).toBe(false)
  })

  it('checkHealth joins when server has an active stream and local room is not joined', async () => {
    const actions = createRuntimeActions({
      pullRuntime: jest.fn().mockResolvedValue({
        task_id: 42,
        task_status: 'RUNNING',
        status_updated_at: '2026-06-01T10:00:00',
        active_stream: {
          subtask_id: 77,
          cursor: 12,
          last_activity_at: '2026-06-01T10:00:01',
        },
      }),
      joinTask: jest.fn().mockResolvedValue({
        streaming: { subtask_id: 77, offset: 12, cached_content: 'hello world!' },
        subtasks: [],
      }),
    })
    const machine = new TaskStateMachine(42, actions)

    await machine.loadTask({
      id: 42,
      status: 'RUNNING',
      updated_at: '2026-06-01T10:00:00',
    })
    await machine.checkHealth('page-visible')

    expect(actions.pullRuntime).toHaveBeenCalledTimes(1)
    expect(actions.joinTask).toHaveBeenCalledWith(42, {
      forceRefresh: true,
      afterMessageId: undefined,
      resumeFromCursor: 0,
      activeStreamSubtaskId: 77,
    })
    expect(machine.getState().runtime.joinedRoom).toBe(true)
    expect(machine.getState().runtime.activeStreamSubtaskId).toBe(77)
  })

  it('checkHealth syncs messages when the task updatedAt has not been message-synced', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const actions = createRuntimeActions({
      pullRuntime: jest.fn().mockResolvedValue({
        task_id: 42,
        task_status: 'COMPLETED',
        status_updated_at: '2026-06-01T10:00:10',
        active_stream: null,
      }),
      joinTask: jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 77,
            task_id: 42,
            team_id: 1,
            title: 'done',
            bot_ids: [],
            role: 'TEAM',
            message_id: 2,
            parent_id: 1,
            prompt: '',
            executor_namespace: '',
            executor_name: '',
            status: 'COMPLETED',
            progress: 100,
            batch: 0,
            result: { value: 'synced answer' },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-01T10:00:05.000Z',
            updated_at: '2026-06-01T10:00:10.000Z',
            completed_at: '2026-06-01T10:00:10.000Z',
            bots: [],
          },
        ],
      }),
    })
    const machine = new TaskStateMachine(42, actions)

    machine.loadTask({
      id: 42,
      status: 'COMPLETED',
      updated_at: '2026-06-01T10:00:10',
    })
    await machine.checkHealth('page-visible')

    expect(actions.joinTask).toHaveBeenCalledWith(42, {
      forceRefresh: true,
      afterMessageId: undefined,
    })
    expect(machine.getState().messages.get('ai-77')?.content).toBe('synced answer')
    expect(machine.getState().runtime.messagesSyncedUpdatedAt).toBe('2026-06-01T10:00:10')
    ;(actions.joinTask as jest.Mock).mockClear()
    await machine.checkHealth('page-visible')
    expect(actions.joinTask).not.toHaveBeenCalled()

    consoleInfoSpy.mockRestore()
  })

  it('does not synthesize interactive form blocks from messages_chain on refresh', async () => {
    const actions = createRuntimeActions({
      pullRuntime: jest.fn().mockResolvedValue({
        task_id: 42,
        task_status: 'COMPLETED',
        status_updated_at: '2026-06-01T10:00:10',
        active_stream: null,
      }),
      joinTask: jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 77,
            task_id: 42,
            team_id: 1,
            title: 'waiting',
            bot_ids: [],
            role: 'TEAM',
            message_id: 2,
            parent_id: 1,
            prompt: '',
            executor_namespace: '',
            executor_name: '',
            status: 'COMPLETED',
            progress: 100,
            batch: 0,
            result: {
              value: '请回答上面的几个问题',
              deferred_user_input: true,
              deferred_user_input_tool_use_id: 'tool_77',
              messages_chain: [
                {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tool_77',
                      type: 'function',
                      function: {
                        name: 'interactive_form_question',
                        arguments: JSON.stringify({
                          questions: [
                            {
                              id: 'genre',
                              question: '你想写什么类型的小说？',
                              input_type: 'choice',
                              options: [{ label: '玄幻/仙侠', value: 'fantasy' }],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
                {
                  role: 'tool',
                  tool_call_id: 'tool_77',
                  name: 'interactive_form_question',
                  content: JSON.stringify({
                    __deferred_user_input__: true,
                    status: 'waiting_for_user_response',
                  }),
                },
              ],
            },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-01T10:00:05.000Z',
            updated_at: '2026-06-01T10:00:10.000Z',
            completed_at: '2026-06-01T10:00:10.000Z',
            bots: [],
          },
        ],
      }),
    })
    const machine = new TaskStateMachine(42, actions)

    machine.loadTask({
      id: 42,
      status: 'COMPLETED',
      updated_at: '2026-06-01T10:00:10',
    })
    await machine.checkHealth('page-visible')

    expect(machine.getState().messages.get('ai-77')?.result?.blocks ?? []).toHaveLength(0)
  })

  it('does not recover persisted interactive form when render payload is missing', async () => {
    const deferredText = JSON.stringify({
      __silent_exit__: true,
      __deferred_user_input__: true,
      success: true,
      status: 'waiting_for_user_response',
    })
    const toolOutput = [{ type: 'text', text: deferredText, id: 'lc_1266' }]
    const actions = createRuntimeActions({
      pullRuntime: jest.fn().mockResolvedValue({
        task_id: 793,
        task_status: 'COMPLETED',
        status_updated_at: '2026-06-03T20:34:56',
        active_stream: null,
      }),
      joinTask: jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 1266,
            task_id: 793,
            team_id: 31,
            title: 'Assistant response',
            bot_ids: [],
            role: 'ASSISTANT',
            message_id: 2,
            parent_id: 1,
            prompt: '',
            executor_namespace: '',
            executor_name: '',
            status: 'COMPLETED',
            progress: 100,
            batch: 0,
            result: {
              value: '我已经发出了第一个澄清表单，请回答这些问题',
              blocks: [
                {
                  id: 'tool_1266',
                  type: 'tool',
                  status: 'done',
                  tool_name:
                    'interactive_wegent-interactive-form-question_interactive_form_question',
                  tool_use_id: 'tool_1266',
                  tool_input: {
                    questions: [
                      {
                        id: 'novel_genre',
                        question: '你想写什么类型的小说？',
                        input_type: 'choice',
                        required: true,
                        options: [{ label: '科幻', value: 'sci_fi' }],
                      },
                    ],
                  },
                  tool_output: toolOutput,
                },
              ],
              stop_reason: 'end_turn',
              deferred_user_input: null,
              deferred_user_input_tool_use_id: null,
              messages_chain: [
                {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tool_1266',
                      type: 'function',
                      function: {
                        name: 'interactive_wegent-interactive-form-question_interactive_form_question',
                        arguments: JSON.stringify({
                          questions: [
                            {
                              id: 'novel_genre',
                              question: '你想写什么类型的小说？',
                              input_type: 'choice',
                              required: true,
                              options: [{ label: '科幻', value: 'sci_fi' }],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
                {
                  role: 'tool',
                  tool_call_id: 'tool_1266',
                  name: 'interactive_wegent-interactive-form-question_interactive_form_question',
                  content: JSON.stringify(toolOutput),
                },
              ],
            },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-03T20:34:40.000Z',
            updated_at: '2026-06-03T20:34:56.000Z',
            completed_at: '2026-06-03T20:34:56.000Z',
            bots: [],
          },
        ],
      }),
    })
    const machine = new TaskStateMachine(793, actions)

    machine.loadTask({
      id: 793,
      status: 'COMPLETED',
      updated_at: '2026-06-03T20:34:56',
    })
    await machine.checkHealth('page-visible')

    const blocks = machine.getState().messages.get('ai-1266')?.result?.blocks ?? []
    expect(blocks).toEqual([
      expect.objectContaining({
        id: 'tool_1266',
        type: 'tool',
        tool_use_id: 'tool_1266',
        status: 'done',
      }),
    ])
    expect(blocks[0]).toMatchObject({
      id: 'tool_1266',
      type: 'tool',
      tool_use_id: 'tool_1266',
      status: 'done',
    })
    expect(blocks[0]).not.toHaveProperty('render_payload')
  })

  it('checkHealth resyncs the active stream message when chat done was missed', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const finalAssistantSubtask = {
      id: 77,
      task_id: 42,
      team_id: 1,
      title: 'done',
      bot_ids: [],
      role: 'TEAM',
      message_id: 2,
      parent_id: 1,
      prompt: '',
      executor_namespace: '',
      executor_name: '',
      status: 'COMPLETED',
      progress: 100,
      batch: 0,
      result: { value: 'partial final answer' },
      error_message: '',
      user_id: 1,
      created_at: '2026-06-01T10:00:05.000Z',
      updated_at: '2026-06-01T10:00:10.000Z',
      completed_at: '2026-06-01T10:00:10.000Z',
      bots: [],
    }
    const actions = createRuntimeActions({
      pullRuntime: jest.fn().mockResolvedValue({
        task_id: 42,
        task_status: 'COMPLETED',
        status_updated_at: '2026-06-01T10:00:10',
        active_stream: null,
      }),
      joinTask: jest.fn().mockImplementation((_taskId, options) =>
        Promise.resolve({
          subtasks: options.afterMessageId === 1 ? [finalAssistantSubtask] : [],
        })
      ),
    })
    const machine = new TaskStateMachine(42, actions)

    machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
    machine.addUserMessage({
      id: 'user-1',
      type: 'user',
      status: 'completed',
      content: 'ask',
      timestamp: Date.now(),
      subtaskId: 1,
      messageId: 1,
    })
    machine.handleChatStart(77, 'Chat', 2)
    machine.handleChatChunk(77, 'partial')
    await machine.checkHealth('page-visible')

    expect(actions.joinTask).toHaveBeenCalledWith(42, {
      forceRefresh: true,
      afterMessageId: 1,
    })
    const message = machine.getState().messages.get('ai-77')
    expect(message?.status).toBe('completed')
    expect(message?.content).toBe('partial final answer')
    expect(machine.getState().runtime.phase).toBe('terminal')

    consoleInfoSpy.mockRestore()
  })

  it('uses chat chunk offsets to ignore content already covered by cached recovery', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const actions = createRuntimeActions({
      joinTask: jest.fn().mockResolvedValue({
        streaming: {
          subtask_id: 77,
          offset: 11,
          cached_content: 'hello world',
        },
        subtasks: [],
      }),
    })
    const machine = new TaskStateMachine(42, actions)

    machine.loadTask({
      id: 42,
      status: 'RUNNING',
      updated_at: '2026-06-01T10:00:00',
    })
    await machine.recover({ force: true })

    machine.handleChatChunk(77, 'hello', undefined, undefined, undefined, 0)
    machine.handleChatChunk(77, ' world', undefined, undefined, undefined, 5)
    machine.handleChatChunk(77, '!', undefined, undefined, undefined, 11)

    const message = machine.getState().messages.get('ai-77')
    expect(message?.content).toBe('hello world!')
    expect(
      message?.result?.blocks
        ?.map(block => (block.type === 'text' || block.type === 'thinking' ? block.content : ''))
        .join('')
    ).toBe('!')

    consoleInfoSpy.mockRestore()
  })

  it('uses chunk offset to replace conflicting local stream tails', async () => {
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    const actions = createRuntimeActions({
      joinTask: jest.fn().mockResolvedValue({
        streaming: {
          subtask_id: 77,
          offset: 11,
          cached_content: 'hello world',
        },
        subtasks: [],
      }),
    })
    const machine = new TaskStateMachine(42, actions)

    machine.loadTask({
      id: 42,
      status: 'RUNNING',
      updated_at: '2026-06-01T10:00:00',
    })
    await machine.recover({ force: true })

    machine.handleChatChunk(77, 'wurld!', undefined, undefined, undefined, 6)

    expect(machine.getState().messages.get('ai-77')?.content).toBe('hello wurld!')

    consoleInfoSpy.mockRestore()
  })

  it('checkHealth clears local streaming when server is terminal with no active stream', async () => {
    const actions = createRuntimeActions({
      pullRuntime: jest.fn().mockResolvedValue({
        task_id: 42,
        task_status: 'COMPLETED',
        status_updated_at: '2026-06-01T10:00:10',
        active_stream: null,
      }),
    })
    const machine = new TaskStateMachine(42, actions)

    machine.handleChatStart(77)
    machine.handleChatChunk(77, 'partial')
    await machine.checkHealth('page-visible')

    const state = machine.getState()
    expect(state.runtime.taskStatus).toBe('COMPLETED')
    expect(state.runtime.phase).toBe('terminal')
    expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
    expect(state.derived.blocksQueuedDispatch).toBe(false)
  })
})
