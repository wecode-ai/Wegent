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
      activeTurnId: null,
      goalStatus: null,
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
    const { address, task, executionPhase, turnPhase, goalStatus, continuable, unread } = this.state
    const executionKnown = executionPhase !== 'unknown'
    const isRunning =
      executionPhase === 'starting' || executionPhase === 'running' || executionPhase === 'stopping'
    const isTurnActive = turnPhase !== 'idle'
    const isThinking = turnPhase === 'submitting' || turnPhase === 'awaiting'
    const isBusy = isRunning || isTurnActive

    return {
      key: getRuntimeTaskLifecycleKey(address),
      address,
      task,
      execution: {
        phase: executionPhase,
        known: executionKnown,
        running: isRunning,
      },
      turn: {
        phase: turnPhase,
        active: isTurnActive,
      },
      goalStatus,
      continuable,
      unread,
      derived: {
        executionKnown,
        isRunning,
        isTurnActive,
        isThinking,
        isBusy,
        canSend: continuable && !isBusy,
        canQueue: continuable && isBusy,
        shouldShowSidebarRunning: isRunning,
        shouldShowUnread: unread && !isRunning,
      },
    }
  }
}

export function getRuntimeTaskLifecycleKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}`
}
