// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Task State exports
 */

export { TaskStateMachine } from './TaskStateMachine'
export { generateMessageId } from './TaskStateMachine.messageUtils'
export type {
  TaskStatus,
  MessageStatus,
  UnifiedMessage,
  StreamingRecoveryPayload,
  TaskRuntimeState,
  TaskRuntimeDerivedState,
  TaskRuntimeVerifyResult,
  TaskRecoveryReason,
  TaskStateSnapshot,
  SyncOptions,
  StateListener,
  TaskStateMachineDeps,
} from './TaskStateMachine.types'

export {
  getRuntimePhaseForTaskStatus,
  isActiveExecutionTaskStatus,
  isTerminalTaskStatus,
  isWaitingForUserTaskStatus,
} from './taskStatusClassifier'
export type { TaskRuntimePhase } from './taskStatusClassifier'
