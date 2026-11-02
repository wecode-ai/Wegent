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
  private readonly observedTurnIds = new Set<string>()
  private readonly settledTurnIds = new Set<string>()
  private readonly retiredExecutorEpochs = new Set<string>()

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
    if (event.type === 'executor_replaced') {
      const epoch = this.state.task?.executionState?.epoch
      if (epoch) this.retiredExecutorEpochs.add(epoch)
    }
    if (event.type === 'executor_snapshot_received') {
      const epoch = event.task.executionState?.epoch
      if (epoch && this.retiredExecutorEpochs.has(epoch)) return false
    }
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
    if (this.state.latestTurnId) this.observeTurn(this.state.latestTurnId)
    const changed = this.state !== previous
    if (changed && event.type === 'turn_settled' && this.state.latestTurnId) {
      this.settledTurnIds.add(this.state.latestTurnId)
    }
    if (changed) this.revision += 1
    return changed
  }

  isPriorTurn(turnId: string): boolean {
    return (
      this.observedTurnIds.has(turnId) &&
      (turnId !== (this.state.activeTurnId ?? this.state.latestTurnId) ||
        this.state.turnPhase === 'submitting' ||
        this.state.turnPhase === 'awaiting')
    )
  }

  observeTurn(turnId: string): void {
    this.observedTurnIds.add(turnId)
  }

  isSettledTurn(turnId: string): boolean {
    return this.settledTurnIds.has(turnId)
  }

  mergeTurnHistory(previous: RuntimeTaskMachine): void {
    for (const turnId of previous.observedTurnIds) this.observedTurnIds.add(turnId)
    for (const turnId of previous.settledTurnIds) this.settledTurnIds.add(turnId)
    for (const epoch of previous.retiredExecutorEpochs) this.retiredExecutorEpochs.add(epoch)
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
      executionPhase === 'starting' ||
      executionPhase === 'running' ||
      executionPhase === 'continuing' ||
      executionPhase === 'recovering' ||
      executionPhase === 'stopping'
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
