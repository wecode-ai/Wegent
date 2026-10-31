import { dequal } from 'dequal'
import {
  isRuntimeGoalExecutionActive,
  isRuntimeTaskAuthoritativeCompletion,
  isRuntimeTaskConfirmedActive,
  isRuntimeTurnRunningStatus,
} from './projection'
import type { RuntimeTaskLifecycleEvent, RuntimeTaskLifecycleState } from './types'

function reduceNativeSnapshot(
  state: RuntimeTaskLifecycleState,
  event: Extract<RuntimeTaskLifecycleEvent, { type: 'executor_snapshot_received' }>
): RuntimeTaskLifecycleState {
  const execution = event.task.executionState
  if (!execution) return state
  const previous = state.task?.executionState
  if (previous && BigInt(execution.revision) <= BigInt(previous.revision)) return state
  return {
    ...state,
    address: mergeAddress(state.address, event.address),
    task: event.task,
    executionPhase: execution.phase,
    turnPhase: execution.turnId
      ? 'streaming'
      : execution.phase === 'starting'
        ? 'awaiting'
        : 'idle',
    activeTurnId: execution.turnId,
    latestTurnId: execution.latestTurnId,
    turnOutcome: execution.outcome,
    goalStatus: event.task.goalStatus ?? null,
    interactionStatus: event.task.interactionStatus ?? null,
    hasAuthoritativeGoalStatus: true,
    continuable: event.task.continuable !== false,
    expectedExecutorRunning: null,
  }
}

export function reduceRuntimeTaskLifecycle(
  state: RuntimeTaskLifecycleState,
  event: RuntimeTaskLifecycleEvent
): RuntimeTaskLifecycleState {
  // Content and RPC completion describe a response, never the native thread's lifetime.
  if (
    state.task?.executionState &&
    [
      'executor_started',
      'executor_settled',
      'turn_started',
      'turn_settled',
      'turn_recovered',
    ].includes(event.type)
  ) {
    return state
  }
  switch (event.type) {
    case 'executor_replaced':
      return {
        ...state,
        task: state.task
          ? { ...state.task, executionState: undefined, cachedProjection: true }
          : null,
        executionPhase: 'unknown',
        turnPhase: 'idle',
        activeTurnId: null,
        expectedExecutorRunning: null,
      }
    case 'executor_snapshot_received': {
      if (event.task.executionState || state.task?.executionState) {
        return reduceNativeSnapshot(state, event)
      }
      const goalExecutionActive = isRuntimeGoalExecutionActive(event.task)
      const snapshotRunning =
        event.task.running === true || goalExecutionActive
          ? true
          : typeof event.task.running === 'boolean'
            ? false
            : null
      const expectedRunning = state.expectedExecutorRunning
      const hasIdentifiedActiveTurn = state.turnPhase === 'streaming' && state.activeTurnId !== null
      const terminalStatus = isTerminalTaskStatus(event.task.status)
      const queuedStatus = isQueuedTaskStatus(event.task.status)
      const completionAdvanced =
        isRuntimeTaskAuthoritativeCompletion(event.task) &&
        event.task.completedAt !== state.task?.completedAt
      const terminalSnapshotAdvanced =
        terminalStatus &&
        (!isTerminalTaskStatus(state.task?.status) ||
          event.task.status !== state.task?.status ||
          completionAdvanced)
      const awaitingContinuationAdmission =
        state.executionPhase === 'starting' &&
        state.task !== null &&
        isRuntimeTaskAuthoritativeCompletion(state.task)
      const snapshotConfirmsSettlement =
        terminalStatus &&
        // A terminal snapshot cannot settle an unresolved admission request.
        !awaitingContinuationAdmission &&
        (!hasIdentifiedActiveTurn || completionAdvanced) &&
        (expectedRunning !== true || terminalSnapshotAdvanced)
      const transitionMismatch =
        snapshotRunning !== null && expectedRunning !== null && snapshotRunning !== expectedRunning
      const snapshotConfirmsAutonomousTurn = isRuntimeTaskConfirmedActive(event.task)
      const snapshotTurnId =
        typeof event.task.runtimeHandle?.lastTurnId === 'string'
          ? event.task.runtimeHandle.lastTurnId
          : null
      const snapshotTurnAlreadySettled =
        snapshotTurnId !== null &&
        snapshotTurnId === state.latestTurnId &&
        state.turnOutcome !== null
      const snapshotRevivesSettledTaskWithoutIntent =
        (Boolean(state.task && isRuntimeTaskAuthoritativeCompletion(state.task)) ||
          (state.executionPhase === 'idle' && state.expectedExecutorRunning === false)) &&
        isRuntimeTaskConfirmedActive(event.task) &&
        state.goalStatus !== null &&
        state.goalStatus !== 'active' &&
        state.expectedExecutorRunning !== true
      if (snapshotRevivesSettledTaskWithoutIntent) {
        return state
      }
      if (
        snapshotTurnAlreadySettled &&
        snapshotConfirmsAutonomousTurn &&
        state.executionPhase === 'idle' &&
        expectedRunning !== true &&
        !goalExecutionActive
      ) {
        return state
      }
      if (
        transitionMismatch &&
        !queuedStatus &&
        !snapshotConfirmsAutonomousTurn &&
        !snapshotConfirmsSettlement
      ) {
        return state
      }

      const executionPhase = goalExecutionActive
        ? 'running'
        : queuedStatus
          ? 'queued'
          : terminalStatus || snapshotRunning === false
            ? 'idle'
            : snapshotRunning === true
              ? 'running'
              : state.executionPhase
      const restoredTurnId =
        !hasIdentifiedActiveTurn &&
        !snapshotTurnAlreadySettled &&
        snapshotConfirmsAutonomousTurn &&
        isRuntimeTurnRunningStatus(event.task.turnStatus)
          ? snapshotTurnId
          : null
      const turnPhase =
        queuedStatus || terminalStatus || snapshotRunning === false
          ? 'idle'
          : restoredTurnId
            ? 'streaming'
            : state.turnPhase
      const activeTurnId =
        queuedStatus || terminalStatus || snapshotRunning === false
          ? null
          : (state.activeTurnId ?? restoredTurnId)
      const hasInteractionStatus = Object.hasOwn(event.task, 'interactionStatus')
      const snapshotInteractionStatus = hasInteractionStatus
        ? (event.task.interactionStatus ?? null)
        : state.interactionStatus
      const interactionStatus =
        terminalStatus && snapshotInteractionStatus !== 'awaitingUserReply'
          ? null
          : snapshotInteractionStatus

      const nextState: RuntimeTaskLifecycleState = {
        ...state,
        address: mergeAddress(state.address, event.address),
        task: event.task,
        executionPhase,
        turnPhase,
        turnOutcome: restoredTurnId ? null : state.turnOutcome,
        activeTurnId,
        latestTurnId:
          typeof event.task.runtimeHandle?.lastTurnId === 'string'
            ? event.task.runtimeHandle.lastTurnId
            : state.latestTurnId,
        interactionStatus,
        goalStatus:
          event.task.goalStatus === undefined || state.hasAuthoritativeGoalStatus
            ? state.goalStatus
            : event.task.goalStatus,
        hasAuthoritativeGoalStatus:
          state.hasAuthoritativeGoalStatus || event.task.goalStatus === null,
        continuable: event.task.continuable !== false,
        expectedExecutorRunning:
          snapshotRunning !== null && event.task.optimistic !== true ? null : expectedRunning,
      }
      return dequal(state, nextState) ? state : nextState
    }

    case 'send_requested':
      return {
        ...state,
        ...(event.workspaceCreationKind
          ? { workspaceCreationKind: event.workspaceCreationKind }
          : {}),
        executionPhase: 'starting',
        turnPhase: 'submitting',
        turnOutcome: null,
        expectedExecutorRunning: true,
        interactionStatus:
          state.interactionStatus === 'awaitingUserReply' ? state.interactionStatus : null,
        unread: false,
      }

    case 'send_accepted':
      return state.expectedExecutorRunning === true
        ? {
            ...state,
            executionPhase: 'running',
            turnPhase: state.turnPhase === 'streaming' ? 'streaming' : 'awaiting',
            turnOutcome: null,
            expectedExecutorRunning: true,
          }
        : state

    case 'send_queued': {
      const executorAlreadyActive = state.task?.running === true || state.activeTurnId !== null
      if (executorAlreadyActive) {
        return {
          ...state,
          executionPhase: 'running',
          turnPhase: state.activeTurnId ? 'streaming' : state.turnPhase,
          expectedExecutorRunning: true,
        }
      }
      return {
        ...state,
        task: state.task
          ? {
              ...state.task,
              running: false,
              status: 'queued',
              ...(event.queuePosition === undefined
                ? {}
                : { queuePosition: event.queuePosition ?? undefined }),
            }
          : state.task,
        executionPhase: 'queued',
        turnPhase: 'idle',
        activeTurnId: null,
        expectedExecutorRunning: false,
      }
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

    case 'send_blocked_by_active_turn':
      return {
        ...state,
        executionPhase: 'running',
        turnPhase: 'idle',
        activeTurnId: null,
        expectedExecutorRunning: null,
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
        latestTurnId: event.turnId ?? state.latestTurnId,
        expectedExecutorRunning: true,
        unread: false,
      }

    case 'turn_settled': {
      if (event.turnId && state.activeTurnId && event.turnId !== state.activeTurnId) {
        return state
      }
      return {
        ...state,
        executionPhase: state.goalStatus === 'complete' ? 'idle' : state.executionPhase,
        turnPhase: 'idle',
        turnOutcome: event.outcome ?? state.turnOutcome,
        activeTurnId: null,
        latestTurnId: event.turnId ?? state.activeTurnId ?? state.latestTurnId,
        expectedExecutorRunning: state.goalStatus === 'complete' ? false : null,
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
            latestTurnId: event.turnId ?? state.latestTurnId,
            expectedExecutorRunning: true,
          }
        : state

    case 'user_input_requested':
      return {
        ...state,
        ...(event.delivery === 'async'
          ? { interactionStatus: 'awaitingUserReply' as const }
          : {
              executionPhase: 'running' as const,
              interactionStatus: 'waitingForUserInput' as const,
              expectedExecutorRunning: true,
            }),
      }

    case 'user_input_responded':
      return state.interactionStatus === null
        ? state
        : state.interactionStatus === 'awaitingUserReply'
          ? { ...state, interactionStatus: null }
          : {
              ...state,
              interactionStatus: null,
              executionPhase: 'running',
              turnPhase: state.turnPhase === 'idle' ? 'awaiting' : state.turnPhase,
              expectedExecutorRunning: true,
            }

    case 'goal_status_received': {
      if (state.task?.executionState) {
        return { ...state, goalStatus: event.goalStatus, hasAuthoritativeGoalStatus: true }
      }
      const goalJustSettled =
        state.goalStatus === 'active' &&
        event.goalStatus !== null &&
        event.goalStatus !== 'active' &&
        (event.goalStatus !== 'complete' || state.turnPhase === 'idle')
      return goalJustSettled
        ? {
            ...state,
            executionPhase: 'idle',
            turnPhase: 'idle',
            activeTurnId: null,
            interactionStatus:
              state.interactionStatus === 'awaitingUserReply' ? state.interactionStatus : null,
            goalStatus: event.goalStatus,
            hasAuthoritativeGoalStatus: true,
            expectedExecutorRunning: false,
          }
        : {
            ...state,
            goalStatus: event.goalStatus,
            hasAuthoritativeGoalStatus: true,
          }
    }

    case 'marked_read':
      return state.unread ? { ...state, unread: false } : state

    case 'marked_unread':
      return state.unread ? state : { ...state, unread: true }
  }
}

function isQueuedTaskStatus(status: string | null | undefined): boolean {
  return status?.trim().toLowerCase() === 'queued'
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
