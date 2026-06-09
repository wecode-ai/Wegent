// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Recovery regression tests for TaskStateMachine.
 *
 * Covers chat stop / recovery edge cases:
 * - transient `isStopping` cleared after sync
 * - stale local streaming messages finalized on recovery
 * - socket reconnect recovery when cancel ack was lost
 * - terminal subtask status preservation (COMPLETED vs FAILED vs CANCELLED)
 * - serverConfirmedNoStream lifecycle
 * - stale pending chunks / late CHAT_CHUNK must not resurrect finalized messages
 */

import { TaskStateMachine, type TaskStateMachineDeps } from '@/features/tasks/state'
import { getChatSendState } from '@/features/tasks/components/input/chatSendState'

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

function computeSendState(machine: TaskStateMachine) {
  const state = machine.getState()
  return getChatSendState({
    isStreaming: state.derived.isStreaming,
    isStopping: state.isStopping,
    isModelSelectionRequired: false,
    isAttachmentReadyToSend: true,
    hasNoTeams: false,
    shouldHideChatInput: false,
    taskInputMessage: 'hello',
    canQueueMessage: state.derived.canQueueMessage,
    canCancelTask: state.derived.canCancelTask,
  }).primaryAction
}

describe('TaskStateMachine recovery', () => {
  describe('recovery invariant: transient isStopping cleared after sync completes', () => {
    let consoleInfoSpy: jest.SpyInstance

    beforeEach(() => {
      consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleInfoSpy.mockRestore()
    })

    it('SYNC_DONE clears isStopping and transitions to ready', async () => {
      const actions = createRuntimeActions({
        pullRuntime: jest.fn().mockResolvedValue({
          task_id: 42,
          task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: null,
        }),
        joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
      })
      const machine = new TaskStateMachine(42, actions)
      machine.handleChatStart(10)
      machine.setStopping(true)

      await machine.checkHealth('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(false)
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)
      expect(computeSendState(machine)).toBe('send')
    })

    it('SYNC_DONE_STREAMING clears isStopping but keeps stop/queue send state', async () => {
      const actions = createRuntimeActions({
        pullRuntime: jest.fn().mockResolvedValue({
          task_id: 42,
          task_status: 'RUNNING',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: {
            subtask_id: 10,
            cursor: 11,
            last_activity_at: '2026-06-01T10:00:05.000Z',
          },
        }),
        joinTask: jest.fn().mockResolvedValue({
          subtasks: [
            {
              id: 10, task_id: 42, team_id: 1, title: 'streaming', bot_ids: [],
              role: 'ASSISTANT', message_id: 1, parent_id: 1, prompt: '',
              executor_namespace: '', executor_name: '', status: 'RUNNING',
              progress: 0, batch: 0, result: { value: 'hello' }, error_message: '',
              user_id: 1, created_at: '2026-06-01T10:00:00.000Z',
              updated_at: '2026-06-01T10:00:05.000Z', completed_at: null, bots: [],
            },
          ],
          streaming: { subtask_id: 10, cached_content: 'hello world', offset: 11 },
        }),
      })
      const machine = new TaskStateMachine(42, actions)
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.handleChatChunk(10, 'hello')
      machine.setStopping(true)

      await machine.checkHealth('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(false)
      expect(state.phase).toBe('streaming')
      expect(state.derived.isStreaming).toBe(true)
      expect(['stop', 'queue']).toContain(computeSendState(machine))
    })
  })

  describe('recovery invariant: isStopping not cleared by unrelated events', () => {
    it('CHAT_CHUNK does not clear isStopping during active stream', () => {
      const machine = new TaskStateMachine(42, createRuntimeActions())
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.handleChatChunk(10, 'hello')
      machine.setStopping(true)
      machine.handleChatChunk(10, ' more data')

      expect(machine.getState().isStopping).toBe(true)
    })

    it('SEND_ACCEPTED clears isStopping', () => {
      const machine = new TaskStateMachine(42, createRuntimeActions())
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.setStopping(true)
      machine.markSendAccepted()

      expect(machine.getState().isStopping).toBe(false)
    })
  })

  describe('cancel sent then socket closed before ack', () => {
    let consoleInfoSpy: jest.SpyInstance

    beforeEach(() => {
      consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleInfoSpy.mockRestore()
    })

    it('[MATRIX 1] recovery finalizes stale streaming and clears isStopping when server confirms no stream', async () => {
      const actions = createRuntimeActions({
        pullRuntime: jest.fn().mockResolvedValue({
          task_id: 42, task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:10', active_stream: null,
        }),
        joinTask: jest.fn().mockResolvedValue({
          subtasks: [
            {
              id: 10, task_id: 42, team_id: 1, title: 'cancelled', bot_ids: [],
              role: 'ASSISTANT', message_id: 1, parent_id: 1, prompt: '',
              executor_namespace: '', executor_name: '', status: 'COMPLETED',
              progress: 100, batch: 0, result: { value: 'partial content' },
              error_message: '', user_id: 1, created_at: '2026-06-01T10:00:00.000Z',
              updated_at: '2026-06-01T10:00:05.000Z',
              completed_at: '2026-06-01T10:00:10.000Z', bots: [],
            },
          ],
        }),
      })

      const machine = new TaskStateMachine(42, actions)
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.handleChatChunk(10, 'partial content')
      machine.setStopping(true)
      expect(machine.getState().isStopping).toBe(true)

      await machine.checkHealth('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(false)
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)
      expect(state.messages.get('ai-10')?.status).toBe('completed')
      expect(computeSendState(machine)).toBe('send')
    })

    it('[MATRIX 2] socket reconnect with stale RUNNING recovers to send with canCancelTask=false', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58, task_id: 9, team_id: 1, title: 'cancelled', bot_ids: [],
            role: 'ASSISTANT', message_id: 2, parent_id: 1, prompt: '',
            executor_namespace: '', executor_name: '', status: 'COMPLETED',
            progress: 100, batch: 0, result: { value: '# Report\n---\nContent' },
            error_message: '', user_id: 1, created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:03:54.000Z',
            completed_at: '2026-06-08T19:04:00.000Z', bots: [],
          },
        ],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, '# Report\n---\nContent so far')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.isStopping).toBe(false)
      expect(state.derived.isStreaming).toBe(false)
      expect(state.messages.get('ai-58')?.status).toBe('completed')
      // KEY: even though taskStatus is RUNNING, cancel should not be available
      // since server confirmed no active stream
      expect(state.runtime.taskStatus).toBe('RUNNING')
      expect(state.derived.canCancelTask).toBe(false)
    })

    it('[MATRIX 6a] CANCELLED subtask finalizes as error', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58, task_id: 9, team_id: 1, title: 'cancelled', bot_ids: [],
            role: 'ASSISTANT', message_id: 2, parent_id: 1, prompt: '',
            executor_namespace: '', executor_name: '', status: 'CANCELLED',
            progress: 50, batch: 0, result: { value: 'partial' }, error_message: '',
            user_id: 1, created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z', bots: [],
          },
        ],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.messages.get('ai-58')?.status).toBe('error')
    })

    it('[MATRIX 6b] FAILED subtask finalizes as error, never completed', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58, task_id: 9, team_id: 1, title: 'failed', bot_ids: [],
            role: 'ASSISTANT', message_id: 2, parent_id: 1, prompt: '',
            executor_namespace: '', executor_name: '', status: 'FAILED',
            progress: 50, batch: 0, result: { value: 'partial' },
            error_message: 'executor crashed', user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z', bots: [],
          },
        ],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.messages.get('ai-58')?.status).toBe('error')
    })

    it('[MATRIX 5] late direct CHAT_CHUNK does not resurrect finalized message to streaming', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58, task_id: 9, team_id: 1, title: 'done', bot_ids: [],
            role: 'ASSISTANT', message_id: 2, parent_id: 1, prompt: '',
            executor_namespace: '', executor_name: '', status: 'COMPLETED',
            progress: 100, batch: 0, result: { value: 'done' }, error_message: '',
            user_id: 1, created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z', bots: [],
          },
        ],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')

      await machine.recover({ force: true })

      expect(machine.getState().phase).toBe('ready')
      expect(machine.getState().derived.isStreaming).toBe(false)

      // Late chunk for the same subtask after recovery finalized it
      machine.handleChatChunk(58, ' stale-chunk')

      // Phase must NOT become streaming again
      expect(machine.getState().phase).toBe('ready')
      expect(machine.getState().derived.isStreaming).toBe(false)
      // Message status must stay completed, not revert
      expect(machine.getState().messages.get('ai-58')?.status).toBe('completed')
    })

    it('[MATRIX 1b] incremental join with empty subtasks and no stream: serverConfirmedNoStream=true, not streaming', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)
      expect(state.derived.serverConfirmedNoStream).toBe(true)
      expect(state.derived.canCancelTask).toBe(false)
      expect(state.derived.blocksQueuedDispatch).toBe(false)
      expect(state.isStopping).toBe(false)
      expect(computeSendState(machine)).toBe('send')
      // Message is NOT marked completed — server confirmed no-stream but
      // no terminal subtask data exists, so use non-success representation
      expect(state.messages.get('ai-58')?.status).not.toBe('completed')
    })

    it('[MATRIX 3] late CHAT_START after finalization does not resurrect', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58, task_id: 9, team_id: 1, title: 'done', bot_ids: [],
            role: 'ASSISTANT', message_id: 2, parent_id: 1, prompt: '',
            executor_namespace: '', executor_name: '', status: 'COMPLETED',
            progress: 100, batch: 0, result: { value: 'done' }, error_message: '',
            user_id: 1, created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z', bots: [],
          },
        ],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')

      await machine.recover({ force: true })

      const stateBefore = machine.getState()
      expect(stateBefore.phase).toBe('ready')
      expect(stateBefore.messages.get('ai-58')?.status).toBe('completed')
      expect(stateBefore.derived.serverConfirmedNoStream).toBe(true)

      machine.handleChatStart(58, 'Chat', 2)

      const stateAfter = machine.getState()
      expect(stateAfter.phase).toBe('ready')
      expect(stateAfter.derived.isStreaming).toBe(false)
      expect(stateAfter.derived.serverConfirmedNoStream).toBe(true)
      expect(stateAfter.messages.get('ai-58')?.status).toBe('completed')
    })

    it('[MATRIX 1c] stale RUNNING subtask with no stream: finalized as error, not streaming', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58, task_id: 9, team_id: 1, title: 'still running', bot_ids: [],
            role: 'ASSISTANT', message_id: 2, parent_id: 1, prompt: '',
            executor_namespace: '', executor_name: '', status: 'RUNNING',
            progress: 50, batch: 0, result: { value: 'partial' }, error_message: '',
            user_id: 1, created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z', completed_at: null, bots: [],
          },
        ],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)
      expect(state.derived.serverConfirmedNoStream).toBe(true)
      expect(state.derived.canCancelTask).toBe(false)
      expect(state.derived.blocksQueuedDispatch).toBe(false)
      expect(state.isStopping).toBe(false)
      expect(computeSendState(machine)).toBe('send')
      // Message must NOT be streaming and NOT completed — non-terminal stale
      // subtask with confirmed no-stream must use non-success representation
      expect(state.messages.get('ai-58')?.status).toBe('error')
    })

    it('[MATRIX 1d] stale PENDING subtask with no stream: finalized as error, not streaming or completed', async () => {
      const joinTask = jest.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58, task_id: 9, team_id: 1, title: 'pending', bot_ids: [],
            role: 'ASSISTANT', message_id: 2, parent_id: 1, prompt: '',
            executor_namespace: '', executor_name: '', status: 'PENDING',
            progress: 0, batch: 0, result: {}, error_message: '',
            user_id: 1, created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z', completed_at: null, bots: [],
          },
        ],
      })

      const machine = new TaskStateMachine(9, { joinTask, isConnected: () => true })
      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)
      expect(state.derived.serverConfirmedNoStream).toBe(true)
      expect(state.derived.canCancelTask).toBe(false)
      expect(state.derived.blocksQueuedDispatch).toBe(false)
      expect(state.isStopping).toBe(false)
      expect(computeSendState(machine)).toBe('send')
      expect(state.messages.get('ai-58')?.status).toBe('error')
      expect(state.messages.get('ai-58')?.status).not.toBe('streaming')
      expect(state.messages.get('ai-58')?.status).not.toBe('completed')
    })
  })
})
