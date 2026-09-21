import type { RuntimeTaskAddress } from '@/types/api'
import { reduceRuntimeTaskLifecycle } from './reducer'
import type {
  RuntimeTaskLifecycleEvent,
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleState,
} from './types'

export class RuntimeTaskMachine {
  private state: RuntimeTaskLifecycleState

  constructor(address: RuntimeTaskAddress, unread = false) {
    this.state = {
      address,
      task: null,
      executionPhase: 'unknown',
      turnPhase: 'idle',
      turnOutcome: null,
      activeTurnId: null,
      goalStatus: null,
      interactionStatus: null,
      hasAuthoritativeGoalStatus: false,
      continuable: false,
      unread,
      expectedExecutorRunning: null,
    }
  }

  dispatch(event: RuntimeTaskLifecycleEvent): boolean {
    const previous = this.state
    this.state = reduceRuntimeTaskLifecycle(previous, event)
    return this.state !== previous
  }

  getState(): RuntimeTaskLifecycleState {
    return this.state
  }

  getSnapshot(): RuntimeTaskLifecycleSnapshot {
    const {
      address,
      task,
      executionPhase,
      turnPhase,
      turnOutcome,
      goalStatus,
      interactionStatus,
      continuable,
      unread,
      workspaceCreationKind,
    } = this.state
    const executionKnown = executionPhase !== 'unknown'
    const isQueued = executionPhase === 'queued'
    const isRunning =
      executionPhase === 'starting' || executionPhase === 'running' || executionPhase === 'stopping'
    const isTurnActive = turnPhase !== 'idle'
    const isThinking = turnPhase === 'submitting' || turnPhase === 'awaiting'
    const isWaitingForUserInput = interactionStatus === 'waitingForUserInput'
    const isBusy = isQueued || isRunning || isTurnActive || isWaitingForUserInput

    return {
      key: getRuntimeTaskLifecycleKey(address),
      address,
      task,
      ...(workspaceCreationKind ? { workspaceCreationKind } : {}),
      execution: {
        phase: executionPhase,
        known: executionKnown,
        running: isRunning,
      },
      turn: {
        phase: turnPhase,
        active: isTurnActive,
        id: this.state.activeTurnId,
        outcome: turnOutcome,
      },
      goalStatus,
      interactionStatus,
      continuable,
      unread,
      derived: {
        executionKnown,
        isRunning,
        isQueued,
        isTurnActive,
        isThinking,
        isBusy,
        canSend: continuable && !isBusy,
        canQueue: continuable && isBusy,
        shouldShowSidebarRunning: isRunning && !isWaitingForUserInput,
        shouldShowSidebarWaiting: isWaitingForUserInput,
        shouldShowUnread: unread && !isRunning && !isWaitingForUserInput,
      },
    }
  }
}

export function getRuntimeTaskLifecycleKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}`
}
