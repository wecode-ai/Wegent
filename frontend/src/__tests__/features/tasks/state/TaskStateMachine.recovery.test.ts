// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Recovery regression tests for TaskStateMachine.
 *
 * Covers chat stop / recovery edge cases split from the main test file:
 * - transient `isStopping` cleared after sync
 * - stale local streaming messages finalized on recovery
 * - socket reconnect recovery when cancel ack was lost
 * - `serverConfirmedNoStream` lifecycle (set on recovery, cleared on new send)
 * - terminal subtask status preservation (COMPLETED vs FAILED vs CANCELLED)
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

/** Compute the primary chat send action for the machine's current state. */
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

interface RecoveryTestCase {
  name: string
  buildDeps: () => TaskStateMachineDeps
  preSetup: (machine: TaskStateMachine) => void
  expectedIsStopping: boolean
  expectedPhase: string
  expectedRuntimePhase?: string
  expectedActiveStreamSubtaskId?: number
  expectedDerivedIsStreaming: boolean
  expectedSendState: string
}

const recoveryTable: RecoveryTestCase[] = [
  {
    name: 'SYNC_DONE clears isStopping, transitions to ready, send state is send',
    buildDeps: () =>
      createRuntimeActions({
        pullRuntime: jest.fn().mockResolvedValue({
          task_id: 42,
          task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: null,
        }),
        joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
      }),
    preSetup: machine => {
      machine.handleChatStart(10)
      machine.setStopping(true)
    },
    expectedIsStopping: false,
    expectedPhase: 'ready',
    expectedDerivedIsStreaming: false,
    expectedSendState: 'send',
  },
  {
    name: 'SYNC_DONE_STREAMING clears isStopping but keeps streaming send state as stop/queue',
    buildDeps: () =>
      createRuntimeActions({
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
          streaming: {
            subtask_id: 10,
            cached_content: 'hello world',
            offset: 11,
          },
        }),
      }),
    preSetup: machine => {
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.handleChatChunk(10, 'hello')
      machine.setStopping(true)
    },
    expectedIsStopping: false,
    expectedPhase: 'streaming',
    expectedRuntimePhase: 'streaming',
    expectedActiveStreamSubtaskId: 10,
    expectedDerivedIsStreaming: true,
    expectedSendState: 'stop',
  },
  {
    name: 'SYNC_DONE with isStopping=false already is a no-op for isStopping',
    buildDeps: () =>
      createRuntimeActions({
        pullRuntime: jest.fn().mockResolvedValue({
          task_id: 42,
          task_status: 'COMPLETED',
          status_updated_at: '2026-06-01T10:00:05',
          active_stream: null,
        }),
        joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
      }),
    preSetup: machine => {
      machine.handleChatStart(10)
    },
    expectedIsStopping: false,
    expectedPhase: 'ready',
    expectedDerivedIsStreaming: false,
    expectedSendState: 'send',
  },
]

describe('TaskStateMachine recovery', () => {
  describe('recovery invariant: transient isStopping cleared after sync completes', () => {
    let consoleInfoSpy: jest.SpyInstance

    beforeEach(() => {
      consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleInfoSpy.mockRestore()
    })

    it.each(recoveryTable)('$name', async testCase => {
      const machine = new TaskStateMachine(42, testCase.buildDeps())

      testCase.preSetup(machine)

      await machine.checkHealth('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(testCase.expectedIsStopping)
      expect(state.phase).toBe(testCase.expectedPhase)

      if (testCase.expectedRuntimePhase !== undefined) {
        expect(state.runtime.phase).toBe(testCase.expectedRuntimePhase)
      }
      if (testCase.expectedActiveStreamSubtaskId !== undefined) {
        expect(state.runtime.activeStreamSubtaskId).toBe(testCase.expectedActiveStreamSubtaskId)
      } else {
        expect(state.runtime.activeStreamSubtaskId).toBeUndefined()
      }
      expect(state.derived.isStreaming).toBe(testCase.expectedDerivedIsStreaming)

      const sendState = computeSendState(machine)
      if (testCase.expectedSendState === 'stop') {
        expect(['stop', 'queue']).toContain(sendState)
      } else {
        expect(sendState).toBe(testCase.expectedSendState)
      }
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
      expect(machine.getState().phase).toBe('streaming')
    })

    it('SEND_ACCEPTED clears isStopping (new send accepted = cancel stop intent)', () => {
      const machine = new TaskStateMachine(42, createRuntimeActions())
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.setStopping(true)

      machine.markSendAccepted()

      expect(machine.getState().isStopping).toBe(false)
    })

    it('TASK_STATUS_RECEIVED (non-terminal) does not clear isStopping', () => {
      const machine = new TaskStateMachine(42, createRuntimeActions())
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.setStopping(true)

      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:10')

      expect(machine.getState().isStopping).toBe(true)
    })

    it('isStopping is only cleared by explicit setStopping(false), CHAT_DONE, CHAT_CANCELLED, CHAT_ERROR, or recovery SYNC_DONE/SYNC_DONE_STREAMING', () => {
      const machine = new TaskStateMachine(42, createRuntimeActions())
      machine.handleTaskStatus('RUNNING', '2026-06-01T10:00:00')
      machine.handleChatStart(10, 'Chat', 1)
      machine.setStopping(true)
      expect(machine.getState().isStopping).toBe(true)

      machine.handleChatDone(10, 'final content', undefined, 1)
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

    it('recovery finalizes stale streaming message and clears isStopping when backend confirms no stream', async () => {
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
      expect(machine.getState().derived.isStreaming).toBe(true)

      machine.setStopping(true)
      expect(machine.getState().isStopping).toBe(true)

      expect(
        getChatSendState({
          isStreaming: machine.getState().derived.isStreaming,
          isStopping: machine.getState().isStopping,
          isModelSelectionRequired: false,
          isAttachmentReadyToSend: true,
          hasNoTeams: false,
          shouldHideChatInput: false,
          taskInputMessage: 'hello',
          canQueueMessage: true,
        }).primaryAction
      ).toBe('loading')

      await machine.checkHealth('page-visible')

      const state = machine.getState()
      expect(state.isStopping).toBe(false)
      expect(state.phase).toBe('ready')
      expect(state.derived.isStreaming).toBe(false)

      const aiMessage = state.messages.get('ai-10')
      expect(aiMessage?.status).toBe('completed')

      expect(
        getChatSendState({
          isStreaming: state.derived.isStreaming,
          isStopping: state.isStopping,
          isModelSelectionRequired: false,
          isAttachmentReadyToSend: true,
          hasNoTeams: false,
          shouldHideChatInput: false,
          taskInputMessage: 'hello',
          canQueueMessage: true,
        }).primaryAction
      ).toBe('send')
    })

    it('socket reconnect recovery with stale taskStatus=RUNNING still recovers to send state', async () => {
      const joinTask = jest.fn().mockResolvedValue({
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

      const machine = new TaskStateMachine(9, {
        joinTask,
        isConnected: () => true,
      })

      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, '# Report\n---\nContent so far')

      expect(machine.getState().phase).toBe('streaming')
      expect(machine.getState().derived.isStreaming).toBe(true)

      machine.setStopping(true)
      expect(machine.getState().isStopping).toBe(true)

      expect(
        getChatSendState({
          isStreaming: true,
          isStopping: true,
          isModelSelectionRequired: false,
          isAttachmentReadyToSend: true,
          hasNoTeams: false,
          shouldHideChatInput: false,
          taskInputMessage: '',
          canQueueMessage: true,
        }).primaryAction
      ).toBe('loading')

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.isStopping).toBe(false)
      expect(state.derived.isStreaming).toBe(false)
      expect(state.derived.serverConfirmedNoStream).toBe(true)

      const aiMessage = state.messages.get('ai-58')
      expect(aiMessage?.status).toBe('completed')

      const isRunningLifecycle = state.runtime.taskStatus === 'RUNNING'
      expect(isRunningLifecycle).toBe(true)
      expect(state.derived.canCancelTask).toBe(false)
      expect(state.derived.blocksQueuedDispatch).toBe(false)

      const effectiveIsStreaming =
        state.derived.isStreaming || (isRunningLifecycle && !state.derived.serverConfirmedNoStream)
      expect(effectiveIsStreaming).toBe(false)

      expect(
        getChatSendState({
          isStreaming: effectiveIsStreaming,
          isStopping: state.isStopping,
          isModelSelectionRequired: false,
          isAttachmentReadyToSend: true,
          hasNoTeams: false,
          shouldHideChatInput: false,
          taskInputMessage: 'hello',
          canQueueMessage: true,
          canCancelTask: state.derived.canCancelTask,
        }).primaryAction
      ).toBe('send')
    })

    it('CANCELLED subtask also triggers serverConfirmedNoStream', async () => {
      const joinTask = jest.fn().mockResolvedValue({
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

      const machine = new TaskStateMachine(9, {
        joinTask,
        isConnected: () => true,
      })

      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.derived.serverConfirmedNoStream).toBe(true)
      expect(state.messages.get('ai-58')?.status).toBe('error')
      expect(state.derived.canCancelTask).toBe(false)
    })

    it('FAILED subtask marks message as error and triggers serverConfirmedNoStream', async () => {
      const joinTask = jest.fn().mockResolvedValue({
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

      const machine = new TaskStateMachine(9, {
        joinTask,
        isConnected: () => true,
      })

      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })

      const state = machine.getState()
      expect(state.phase).toBe('ready')
      expect(state.derived.serverConfirmedNoStream).toBe(true)
      expect(state.messages.get('ai-58')?.status).toBe('error')
      expect(state.derived.canCancelTask).toBe(false)
    })

    it('new send after serverConfirmedNoStream clears the flag', async () => {
      const joinTask = jest.fn().mockResolvedValue({
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

      const machine = new TaskStateMachine(9, {
        joinTask,
        isConnected: () => true,
      })

      machine.handleTaskStatus('RUNNING', '2026-06-08T19:03:54')
      machine.handleChatStart(58, 'Chat', 2)
      machine.handleChatChunk(58, 'partial')
      machine.setStopping(true)

      await machine.recover({ force: true })
      expect(machine.getState().derived.serverConfirmedNoStream).toBe(true)

      machine.markSendAccepted('2026-06-08T19:05:00.000Z')

      expect(machine.getState().derived.serverConfirmedNoStream).toBe(false)
    })
  })
})
