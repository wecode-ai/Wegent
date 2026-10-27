import type { RuntimeTaskAddress } from '@/types/api'
import { reduceRuntimeTaskLifecycle } from './reducer'
import type {
  RuntimeTaskLifecycleEvent,
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleState,
} from './types'

export class RuntimeTaskMachine {
  private state: RuntimeTaskLifecycleState
  private revision = 0
  // History can reveal a turn before an executor snapshot confirms it.
  private readonly observedTurns = new Map<string, boolean>()

  constructor(address: RuntimeTaskAddress, unread = false) {
    this.state = {
      address,
      task: null,
      executionPhase: 'unknown',
      turnPhase: 'idle',
      turnOutcome: null,
      activeTurnId: null,
      latestTurnId: null,
      goalStatus: null,
      interactionStatus: null,
      hasAuthoritativeGoalStatus: false,
      continuable: false,
      unread,
      expectedExecutorRunning: null,
    }
  }

  dispatch(event: RuntimeTaskLifecycleEvent): boolean {
    if (
      event.type === 'turn_settled' &&
      this.state.turnPhase !== 'idle' &&
      event.turnId &&
      this.isPriorTurn(event.turnId)
    ) {
      return false
    }
    const previous = this.state
    this.state = reduceRuntimeTaskLifecycle(previous, event)
    if (this.state.latestTurnId) this.observeTurn(this.state.latestTurnId, true)
    const changed = this.state !== previous
    if (changed) this.revision += 1
    return changed
  }

  isPriorTurn(turnId: string): boolean {
    return (
      this.observedTurns.has(turnId) &&
      (turnId !== (this.state.activeTurnId ?? this.state.latestTurnId) ||
        this.state.turnPhase === 'submitting' ||
        this.state.turnPhase === 'awaiting')
    )
  }

  hasAcceptedTurn(turnId: string): boolean {
    return this.observedTurns.get(turnId) === true
  }

  observeTurn(turnId: string, accepted = false): void {
    this.observedTurns.set(turnId, accepted || this.hasAcceptedTurn(turnId))
  }

  mergeTurnHistory(previous: RuntimeTaskMachine): void {
    for (const [turnId, accepted] of previous.observedTurns) this.observeTurn(turnId, accepted)
  }

  getState(): RuntimeTaskLifecycleState {
    return this.state
  }

  getRevision(): number {
    return this.revision
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
    const hasPendingUserInput = isWaitingForUserInput || interactionStatus === 'awaitingUserReply'
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
        latestId: this.state.latestTurnId,
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
        shouldShowSidebarRunning: isRunning && !hasPendingUserInput,
        shouldShowSidebarWaiting: hasPendingUserInput,
        shouldShowUnread: unread && !isRunning && !hasPendingUserInput,
      },
    }
  }
}

export function getRuntimeTaskLifecycleKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}`
}
