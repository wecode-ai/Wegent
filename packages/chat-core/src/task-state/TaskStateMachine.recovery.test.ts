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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStateMachine, type TaskStateMachineDeps } from '..'

function createRuntimeActions(overrides: Partial<TaskStateMachineDeps> = {}): TaskStateMachineDeps {
  return {
    joinTask: vi.fn().mockResolvedValue({ subtasks: [] }),
    pullRuntime: vi.fn().mockResolvedValue({
      task_id: 42,
      task_status: 'COMPLETED',
      status_updated_at: '2026-06-01T10:00:00',
      active_stream: null,
    }),
    isConnected: vi.fn(() => true),
    ...overrides,
  }
}

type JoinTaskResponse = Awaited<ReturnType<TaskStateMachineDeps['joinTask']>>

describe('TaskStateMachine recovery', () => {
  describe('recovery invariant: transient isStopping cleared after sync completes', () => {
    let consoleInfoSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleInfoSpy.mockRestore()
    })

    it('SYNC_DONE clears isStopping and transitions to ready', async () => {
      const actions = createRuntimeActions({
        pullRuntime: vi.fn().mockResolvedValue({
          task_id: 42,
          task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: null,
        }),
        joinTask: vi.fn().mockResolvedValue({ subtasks: [] }),
      })
      const machine = new TaskStateMachine(42, actions)
      machine.handleChatStart(10)
      machine.setStopping(true)

      await machine.requestRuntimeCheck('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(false)
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)
      expect(state.derived.canSendMessage).toBe(true)
    })

    it('SYNC_DONE_STREAMING clears isStopping but keeps stop/queue send state', async () => {
      const actions = createRuntimeActions({
        pullRuntime: vi.fn().mockResolvedValue({
          task_id: 42,
          task_status: 'RUNNING',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: {
            subtask_id: 10,
            cursor: 11,
            last_activity_at: '2026-06-01T10:00:05.000Z',
          },
        }),
        joinTask: vi.fn().mockResolvedValue({
          subtasks: [
            {
              id: 10,
              task_id: 42,
              team_id: 1,
              title: 'streaming',
              bot_ids: [],
              role: 'ASSISTANT',
              message_id: 1,
              parent_id: 1,
              prompt: '',
              executor_namespace: '',
              executor_name: '',
              status: 'RUNNING',
              progress: 0,
              batch: 0,
              result: { value: 'hello' },
              error_message: '',
              user_id: 1,
              created_at: '2026-06-01T10:00:00.000Z',
              updated_at: '2026-06-01T10:00:05.000Z',
              completed_at: null,
              bots: [],
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

      await machine.requestRuntimeCheck('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(false)
      expect(state.phase).toBe('streaming')
      expect(state.derived.isStreaming).toBe(true)
      expect(state.derived.canSendMessage).toBe(false)
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

    it('RUNNING without server no-stream confirmation is exposed as streaming', () => {
      const machine = new TaskStateMachine(42, createRuntimeActions())

      machine.markSendAccepted('2026-06-01T10:00:00')

      const state = machine.getState()
      expect(state.runtime.taskStatus).toBe('RUNNING')
      expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
      expect(state.derived.isStreaming).toBe(true)
      expect(state.derived.canSendMessage).toBe(false)
      expect(state.isStopping).toBe(false)
    })

    it('state machine probes runtime instability and exits unknown stream when runtime confirms no stream', async () => {
      vi.useFakeTimers()
      const pullRuntime = vi.fn().mockResolvedValue({
        task_id: 42,
        task_status: 'RUNNING',
        status_updated_at: '2026-06-01T10:00:05',
        active_stream: null,
      })
      const machine = new TaskStateMachine(
        42,
        createRuntimeActions({
          pullRuntime,
        })
      )

      try {
        machine.markSendAccepted('2026-06-01T10:00:00')

        expect(machine.getState().derived.isStreaming).toBe(true)
        await vi.advanceTimersByTimeAsync(2999)
        expect(pullRuntime).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)

        expect(pullRuntime).toHaveBeenCalledTimes(1)
        const state = machine.getState()
        expect(state.runtime.taskStatus).toBe('RUNNING')
        expect(state.runtime.serverConfirmedNoStream).toBe(true)
        expect(state.derived.isStreaming).toBe(false)
        expect(state.derived.canSendMessage).toBe(true)
      } finally {
        machine.closeTask()
        vi.useRealTimers()
      }
    })

    it('state machine retries runtime instability probe until runtime reaches a stable state', async () => {
      vi.useFakeTimers()
      const pullRuntime = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary network failure'))
        .mockResolvedValueOnce({
          task_id: 42,
          task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: null,
        })
      const machine = new TaskStateMachine(
        42,
        createRuntimeActions({
          pullRuntime,
        })
      )

      try {
        machine.markSendAccepted('2026-06-01T10:00:00')

        await vi.advanceTimersByTimeAsync(3000)
        expect(pullRuntime).toHaveBeenCalledTimes(1)
        expect(machine.getState().derived.isStreaming).toBe(true)

        await vi.advanceTimersByTimeAsync(3000)

        expect(pullRuntime).toHaveBeenCalledTimes(2)
        expect(machine.getState().derived.isStreaming).toBe(false)
      } finally {
        machine.closeTask()
        vi.useRealTimers()
      }
    })

    it('state machine stops runtime instability probe when chat:start makes the stream known', async () => {
      vi.useFakeTimers()
      const pullRuntime = vi.fn()
      const machine = new TaskStateMachine(
        42,
        createRuntimeActions({
          pullRuntime,
        })
      )

      try {
        machine.markSendAccepted('2026-06-01T10:00:00')
        machine.handleChatStart(10, 'Chat', 1)

        await vi.advanceTimersByTimeAsync(3000)

        expect(pullRuntime).not.toHaveBeenCalled()
        expect(machine.getState().runtime.activeStreamSubtaskId).toBe(10)
      } finally {
        machine.closeTask()
        vi.useRealTimers()
      }
    })

    it('state machine probes cancel pending state with the same runtime instability delay', async () => {
      vi.useFakeTimers()
      const pullRuntime = vi.fn().mockResolvedValue({
        task_id: 42,
        task_status: 'RUNNING',
        status_updated_at: '2026-06-01T10:00:05',
        active_stream: null,
      })
      const machine = new TaskStateMachine(
        42,
        createRuntimeActions({
          pullRuntime,
        })
      )

      try {
        machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
        machine.handleChatStart(10, 'Chat', 1)
        machine.setStopping(true)

        await vi.advanceTimersByTimeAsync(2999)
        expect(pullRuntime).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)

        expect(pullRuntime).toHaveBeenCalledTimes(1)
        const state = machine.getState()
        expect(state.isStopping).toBe(false)
        expect(state.runtime.serverConfirmedNoStream).toBe(true)
        expect(state.derived.isStreaming).toBe(false)
      } finally {
        machine.closeTask()
        vi.useRealTimers()
      }
    })

    it('state machine retries cancel pending runtime instability until runtime reaches a stable state', async () => {
      vi.useFakeTimers()
      const pullRuntime = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary network failure'))
        .mockResolvedValueOnce({
          task_id: 42,
          task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: null,
        })
      const machine = new TaskStateMachine(
        42,
        createRuntimeActions({
          pullRuntime,
        })
      )

      try {
        machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
        machine.handleChatStart(10, 'Chat', 1)
        machine.setStopping(true)

        await vi.advanceTimersByTimeAsync(3000)
        expect(pullRuntime).toHaveBeenCalledTimes(1)
        expect(machine.getState().isStopping).toBe(true)

        await vi.advanceTimersByTimeAsync(3000)

        expect(pullRuntime).toHaveBeenCalledTimes(2)
        expect(machine.getState().isStopping).toBe(false)
        expect(machine.getState().derived.isStreaming).toBe(false)
      } finally {
        machine.closeTask()
        vi.useRealTimers()
      }
    })

    it('state machine stops runtime instability probe when chat:cancelled arrives', async () => {
      vi.useFakeTimers()
      const pullRuntime = vi.fn()
      const machine = new TaskStateMachine(
        42,
        createRuntimeActions({
          pullRuntime,
        })
      )

      try {
        machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
        machine.handleChatStart(10, 'Chat', 1)
        machine.setStopping(true)
        machine.handleChatCancelled(10)

        await vi.advanceTimersByTimeAsync(3000)

        expect(pullRuntime).not.toHaveBeenCalled()
        expect(machine.getState().isStopping).toBe(false)
      } finally {
        machine.closeTask()
        vi.useRealTimers()
      }
    })
  })

  it('ignores stale join rejection after the task is reopened', async () => {
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    let rejectFirstJoin!: (error: Error) => void
    let resolveSecondJoin!: (response: JoinTaskResponse) => void
    const firstJoin = new Promise<JoinTaskResponse>((_resolve, reject) => {
      rejectFirstJoin = reject
    })
    const secondJoin = new Promise<JoinTaskResponse>(resolve => {
      resolveSecondJoin = resolve
    })
    const joinTask = vi.fn().mockReturnValueOnce(firstJoin).mockReturnValueOnce(secondJoin)
    const leaveTask = vi.fn()

    try {
      const machine = new TaskStateMachine(42, {
        joinTask,
        leaveTask,
        isConnected: () => true,
      })

      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      const firstRecover = machine.recover({ force: true })
      expect(joinTask).toHaveBeenCalledTimes(1)

      machine.closeTask()

      const secondRecover = machine.openTask()
      expect(joinTask).toHaveBeenCalledTimes(2)

      rejectFirstJoin(new Error('obsolete join failed'))
      await firstRecover

      expect(machine.getState().phase).toBe('joining')
      expect(machine.getState().error).toBeNull()
      expect(leaveTask).toHaveBeenCalledTimes(1)

      resolveSecondJoin({ subtasks: [] })
      await secondRecover

      expect(machine.getState().phase).toBe('ready')
      expect(machine.getState().error).toBeNull()
    } finally {
      consoleInfoSpy.mockRestore()
    }
  })

  describe('cancel sent then socket closed before ack', () => {
    let consoleInfoSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleInfoSpy.mockRestore()
    })

    it('[MATRIX 1] recovery finalizes stale streaming and clears isStopping when server confirms no stream', async () => {
      const actions = createRuntimeActions({
        pullRuntime: vi.fn().mockResolvedValue({
          task_id: 42,
          task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:10',
          active_stream: null,
        }),
        joinTask: vi.fn().mockResolvedValue({
          subtasks: [
            {
              id: 10,
              task_id: 42,
              team_id: 1,
              title: 'cancelled',
              bot_ids: [],
              role: 'ASSISTANT',
              message_id: 1,
              parent_id: 1,
              prompt: '',
              executor_namespace: '',
              executor_name: '',
              status: 'COMPLETED',
              progress: 100,
              batch: 0,
              result: { value: 'partial content' },
              error_message: '',
              user_id: 1,
              created_at: '2026-06-01T10:00:00.000Z',
              updated_at: '2026-06-01T10:00:05.000Z',
              completed_at: '2026-06-01T10:00:10.000Z',
              bots: [],
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

      await machine.requestRuntimeCheck('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(false)
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)
      const message = state.messages.get('ai-10')
      expect(message?.status).toBe('completed')
      expect(message?.subtaskStatus).toBe('COMPLETED')
      expect(message?.isReasoningStreaming).toBe(false)
      expect(state.derived.canSendMessage).toBe(true)
    })

    it('[MATRIX 2] socket reconnect with stale RUNNING recovers to send with canCancelTask=false', async () => {
      const joinTask = vi.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58,
            task_id: 9,
            team_id: 1,
            title: 'cancelled',
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
            result: { value: '# Report\n---\nContent' },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:03:54.000Z',
            completed_at: '2026-06-08T19:04:00.000Z',
            bots: [],
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
      const joinTask = vi.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58,
            task_id: 9,
            team_id: 1,
            title: 'cancelled',
            bot_ids: [],
            role: 'ASSISTANT',
            message_id: 2,
            parent_id: 1,
            prompt: '',
            executor_namespace: '',
            executor_name: '',
            status: 'CANCELLED',
            progress: 50,
            batch: 0,
            result: { value: 'partial' },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z',
            bots: [],
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
      const joinTask = vi.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58,
            task_id: 9,
            team_id: 1,
            title: 'failed',
            bot_ids: [],
            role: 'ASSISTANT',
            message_id: 2,
            parent_id: 1,
            prompt: '',
            executor_namespace: '',
            executor_name: '',
            status: 'FAILED',
            progress: 50,
            batch: 0,
            result: { value: 'partial' },
            error_message: 'executor crashed',
            user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z',
            bots: [],
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
      const joinTask = vi.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58,
            task_id: 9,
            team_id: 1,
            title: 'done',
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
            result: { value: 'done' },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z',
            bots: [],
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
      const joinTask = vi.fn().mockResolvedValue({
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
      expect(state.derived.canSendMessage).toBe(true)
      // Message is NOT marked completed — server confirmed no-stream but
      // no terminal subtask data exists, so use non-success representation
      expect(state.messages.get('ai-58')?.status).not.toBe('completed')
    })

    it('[MATRIX 3] late CHAT_START after finalization does not resurrect', async () => {
      const joinTask = vi.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58,
            task_id: 9,
            team_id: 1,
            title: 'done',
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
            result: { value: 'done' },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: '2026-06-08T19:04:00.000Z',
            bots: [],
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
      const joinTask = vi.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58,
            task_id: 9,
            team_id: 1,
            title: 'still running',
            bot_ids: [],
            role: 'ASSISTANT',
            message_id: 2,
            parent_id: 1,
            prompt: '',
            executor_namespace: '',
            executor_name: '',
            status: 'RUNNING',
            progress: 50,
            batch: 0,
            result: { value: 'partial' },
            error_message: '',
            user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: null,
            bots: [],
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
      expect(state.derived.canSendMessage).toBe(true)
      // Message must NOT be streaming and NOT completed — non-terminal stale
      // subtask with confirmed no-stream must use non-success representation
      const message = state.messages.get('ai-58')
      expect(message?.status).toBe('error')
      expect(message?.subtaskStatus).toBe('RUNNING')
      expect(message?.isReasoningStreaming).toBe(false)
    })

    it('[MATRIX 1d] stale PENDING subtask with no stream: finalized as error, not streaming or completed', async () => {
      const joinTask = vi.fn().mockResolvedValue({
        subtasks: [
          {
            id: 58,
            task_id: 9,
            team_id: 1,
            title: 'pending',
            bot_ids: [],
            role: 'ASSISTANT',
            message_id: 2,
            parent_id: 1,
            prompt: '',
            executor_namespace: '',
            executor_name: '',
            status: 'PENDING',
            progress: 0,
            batch: 0,
            result: {},
            error_message: '',
            user_id: 1,
            created_at: '2026-06-08T19:03:00.000Z',
            updated_at: '2026-06-08T19:04:00.000Z',
            completed_at: null,
            bots: [],
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
      expect(state.derived.canSendMessage).toBe(true)
      const message = state.messages.get('ai-58')
      expect(message?.status).toBe('error')
      expect(message?.status).not.toBe('streaming')
      expect(message?.subtaskStatus).toBe('PENDING')
      expect(message?.isReasoningStreaming).toBe(false)
      expect(state.messages.get('ai-58')?.status).not.toBe('completed')
    })

    it('runtime check fast path exits unknown when server confirms no stream', async () => {
      const statusUpdatedAt = '2026-06-08T19:03:54'
      const joinTask = vi.fn().mockResolvedValue({ subtasks: [] })
      const pullRuntime = vi.fn().mockResolvedValue({
        task_id: 9,
        task_status: 'RUNNING',
        status_updated_at: statusUpdatedAt,
        active_stream: null,
      })
      const machine = new TaskStateMachine(9, {
        joinTask,
        pullRuntime,
        isConnected: () => true,
      })

      await machine.recover({ force: true, syncUpdatedAt: statusUpdatedAt })
      machine.markSendAccepted(statusUpdatedAt)
      expect(machine.getState().derived.isStreaming).toBe(true)

      await machine.requestRuntimeCheck('page-visible')

      const state = machine.getState()
      expect(joinTask).toHaveBeenCalledTimes(1)
      expect(state.runtime.serverConfirmedNoStream).toBe(true)
      expect(state.derived.isStreaming).toBe(false)
      expect(state.derived.canSendMessage).toBe(true)
      expect(state.derived.canCancelTask).toBe(false)
      expect(state.derived.blocksQueuedDispatch).toBe(false)
      expect(state.isStopping).toBe(false)
    })

    it('runtime check fast path finalizes stale streaming messages when server has no stream', async () => {
      const statusUpdatedAt = '2026-06-08T19:03:54'
      const joinTask = vi.fn().mockResolvedValue({ subtasks: [] })
      const pullRuntime = vi.fn().mockResolvedValue({
        task_id: 9,
        task_status: 'RUNNING',
        status_updated_at: statusUpdatedAt,
        active_stream: null,
      })
      const machine = new TaskStateMachine(9, {
        joinTask,
        pullRuntime,
        isConnected: () => true,
      })

      await machine.recover({ force: true, syncUpdatedAt: statusUpdatedAt })
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.requestRuntimeCheck('page-visible')

      const state = machine.getState()
      expect(joinTask).toHaveBeenCalledTimes(1)
      expect(state.runtime.serverConfirmedNoStream).toBe(true)
      expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
      expect(state.isStopping).toBe(false)
      expect(state.derived.isStreaming).toBe(false)
      const message = state.messages.get('ai-58')
      expect(message?.status).toBe('error')
      expect(message?.isReasoningStreaming).toBe(false)

      machine.handleChatChunk(58, ' stale-chunk')

      const stateAfterLateChunk = machine.getState()
      expect(stateAfterLateChunk.derived.isStreaming).toBe(false)
      expect(stateAfterLateChunk.messages.get('ai-58')?.status).toBe('error')
      expect(stateAfterLateChunk.messages.get('ai-58')?.content).toBe('partial')
    })
  })
})
