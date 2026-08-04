import type { RuntimeTaskLifecycleEvent, RuntimeTaskLifecycleState } from './types'

export function reduceRuntimeTaskLifecycle(
  state: RuntimeTaskLifecycleState,
  event: RuntimeTaskLifecycleEvent
): RuntimeTaskLifecycleState {
  switch (event.type) {
    case 'executor_snapshot_received': {
      const snapshotRunning = typeof event.task.running === 'boolean' ? event.task.running : null
      const expectedRunning = state.expectedExecutorRunning
      const shouldIgnoreStaleSnapshot =
        snapshotRunning !== null &&
        expectedRunning !== null &&
        snapshotRunning !== expectedRunning &&
        !isTerminalTaskStatus(event.task.status)
      const executionPhase =
        snapshotRunning === null
          ? state.executionPhase
          : shouldIgnoreStaleSnapshot
            ? state.executionPhase
            : snapshotRunning
              ? 'running'
              : 'idle'
      const turnPhase =
        snapshotRunning === false && !shouldIgnoreStaleSnapshot ? 'idle' : state.turnPhase
      const activeTurnId =
        snapshotRunning === false && !shouldIgnoreStaleSnapshot ? null : state.activeTurnId

      return {
        ...state,
        address: mergeAddress(state.address, event.address),
        task: event.task,
        executionPhase,
        turnPhase,
        activeTurnId,
        goalStatus: event.task.goalStatus === undefined ? state.goalStatus : event.task.goalStatus,
        continuable: event.task.continuable !== false,
        expectedExecutorRunning:
          snapshotRunning !== null &&
          event.task.optimistic !== true &&
          (snapshotRunning === expectedRunning || isTerminalTaskStatus(event.task.status))
            ? null
            : expectedRunning,
      }
    }

    case 'send_requested':
      return {
        ...state,
        executionPhase: 'starting',
        turnPhase: 'submitting',
        turnOutcome: null,
        expectedExecutorRunning: true,
        unread: false,
      }

    case 'send_accepted':
      return {
        ...state,
        executionPhase: 'running',
        turnPhase: state.turnPhase === 'streaming' ? 'streaming' : 'awaiting',
        turnOutcome: null,
        expectedExecutorRunning: true,
      }

    case 'send_rejected': {
      const executorAlreadyConfirmed =
        state.executionPhase === 'running' || state.turnPhase === 'streaming'
      return executorAlreadyConfirmed
        ? state
        : {
            ...state,
            executionPhase: 'idle',
            turnPhase: 'idle',
            expectedExecutorRunning: false,
          }
    }

    case 'stop_requested':
      return {
        ...state,
        executionPhase: state.executionPhase === 'idle' ? 'idle' : 'stopping',
      }

    case 'stop_rejected':
      return {
        ...state,
        executionPhase: state.executionPhase === 'stopping' ? 'running' : state.executionPhase,
      }

    case 'executor_started':
      return {
        ...state,
        executionPhase: 'running',
        turnOutcome: null,
        expectedExecutorRunning: true,
        unread: false,
      }

    case 'executor_settled':
      return {
        ...state,
        executionPhase: 'idle',
        turnPhase: 'idle',
        activeTurnId: null,
        expectedExecutorRunning: false,
      }

    case 'turn_started':
      return {
        ...state,
        executionPhase: 'running',
        turnPhase: 'streaming',
        turnOutcome: null,
        activeTurnId: event.turnId ?? null,
        expectedExecutorRunning: true,
        unread: false,
      }

    case 'turn_settled': {
      if (event.turnId && state.activeTurnId && event.turnId !== state.activeTurnId) {
        return state
      }
      return {
        ...state,
        executionPhase: state.goalStatus === 'active' ? state.executionPhase : 'idle',
        turnPhase: 'idle',
        turnOutcome: event.outcome ?? state.turnOutcome,
        activeTurnId: null,
        expectedExecutorRunning:
          state.goalStatus === 'active' ? state.expectedExecutorRunning : false,
      }
    }

    case 'turn_recovered':
      return event.streaming
        ? {
            ...state,
            executionPhase: 'running',
            turnPhase: 'streaming',
            turnOutcome: null,
            activeTurnId: event.turnId ?? null,
            expectedExecutorRunning: true,
          }
        : state

    case 'goal_status_received':
      return {
        ...state,
        goalStatus: event.goalStatus,
      }

    case 'marked_read':
      return state.unread ? { ...state, unread: false } : state

    case 'marked_unread':
      return state.unread ? state : { ...state, unread: true }
  }
}

function isTerminalTaskStatus(status: string | null | undefined): boolean {
  const normalized = status?.replace(/[_-]/g, '').trim().toLowerCase()
  return Boolean(
    normalized &&
    ['done', 'complete', 'completed', 'failed', 'error', 'cancelled', 'canceled'].includes(
      normalized
    )
  )
}

function mergeAddress(
  current: RuntimeTaskLifecycleState['address'],
  incoming: RuntimeTaskLifecycleState['address']
): RuntimeTaskLifecycleState['address'] {
  return {
    ...current,
    ...incoming,
    threadId: incoming.threadId ?? current.threadId,
    workspacePath: incoming.workspacePath ?? current.workspacePath,
    runtimeHandle: incoming.runtimeHandle ?? current.runtimeHandle,
  }
}
