// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Task State exports
 */

export { TaskStateMachine, generateMessageId } from './TaskStateMachine'
export type {
  TaskStatus,
  MessageStatus,
  UnifiedMessage,
  StreamingInfo,
  TaskRuntimeState,
  TaskRuntimeDerivedState,
  TaskRuntimeVerifyResult,
  TaskRecoveryReason,
  TaskStateData,
  SyncOptions,
  StateListener,
  TaskStateMachineDeps,
} from './TaskStateMachine'

export { taskStateManager } from './TaskStateManager'
export {
  getRuntimePhaseForTaskStatus,
  isActiveExecutionTaskStatus,
  isTerminalTaskStatus,
  isWaitingForUserTaskStatus,
} from './taskStatusClassifier'
export type { TaskRuntimePhase } from './taskStatusClassifier'
