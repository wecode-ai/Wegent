import type { RuntimeGoalStatus, RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'

export type RuntimeTaskExecutionPhase =
  | 'unknown'
  | 'idle'
  | 'queued'
  | 'starting'
  | 'running'
  | 'stopping'

export type RuntimeTaskTurnPhase = 'idle' | 'submitting' | 'awaiting' | 'streaming'

export type RuntimeTaskTurnOutcome = 'succeeded' | 'failed' | 'cancelled' | null

export interface RuntimeTaskLifecycleState {
  address: RuntimeTaskAddress
  task: RuntimeTaskSummary | null
  workspaceCreationKind?: string
  executionPhase: RuntimeTaskExecutionPhase
  turnPhase: RuntimeTaskTurnPhase
  turnOutcome: RuntimeTaskTurnOutcome
  activeTurnId: string | null
  goalStatus: RuntimeGoalStatus | null
  continuable: boolean
  unread: boolean
  expectedExecutorRunning: boolean | null
}

export interface RuntimeTaskLifecycleDerivedState {
  executionKnown: boolean
  isRunning: boolean
  isQueued: boolean
  isTurnActive: boolean
  isThinking: boolean
  isBusy: boolean
  canSend: boolean
  canQueue: boolean
  shouldShowSidebarRunning: boolean
  shouldShowUnread: boolean
}

export interface RuntimeTaskLifecycleSnapshot {
  key: string
  address: RuntimeTaskAddress
  task: RuntimeTaskSummary | null
  workspaceCreationKind?: string
  execution: {
    phase: RuntimeTaskExecutionPhase
    known: boolean
    running: boolean
  }
  turn: {
    phase: RuntimeTaskTurnPhase
    active: boolean
    id: string | null
    outcome: RuntimeTaskTurnOutcome
  }
  goalStatus: RuntimeGoalStatus | null
  continuable: boolean
  unread: boolean
  derived: RuntimeTaskLifecycleDerivedState
}

export type RuntimeTaskLifecycleEvent =
  | {
      type: 'executor_snapshot_received'
      address: RuntimeTaskAddress
      task: RuntimeTaskSummary
    }
  | { type: 'send_requested'; workspaceCreationKind?: string }
  | { type: 'send_accepted' }
  | { type: 'send_rejected' }
  | { type: 'send_blocked_by_active_turn' }
  | { type: 'stop_requested' }
  | { type: 'stop_rejected' }
  | { type: 'executor_started' }
  | { type: 'executor_settled' }
  | { type: 'turn_started'; turnId?: string | null }
  | {
      type: 'turn_settled'
      turnId?: string | null
      outcome?: Exclude<RuntimeTaskTurnOutcome, null>
    }
  | { type: 'turn_recovered'; streaming: boolean; turnId?: string | null }
  | { type: 'goal_status_received'; goalStatus: RuntimeGoalStatus | null }
  | { type: 'marked_read' }
  | { type: 'marked_unread' }

export interface RuntimeTaskLifecycleStoreSnapshot {
  version: number
  tasks: ReadonlyMap<string, RuntimeTaskLifecycleSnapshot>
  runningTaskKeys: ReadonlySet<string>
  queuedTaskKeys: ReadonlySet<string>
  unreadTaskKeys: ReadonlySet<string>
}
