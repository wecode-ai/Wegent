// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskStatus as ApiTaskStatus } from '@/types/api'
import type {
  MessageStatus,
  TaskMachineInternalState,
  TaskRuntimeDerivedState,
  TaskRuntimeState,
  UnifiedMessage,
} from './TaskStateMachine.types'
import {
  getRuntimePhaseForTaskStatus,
  isActiveExecutionTaskStatus,
  isTerminalTaskStatus,
} from './taskStatusClassifier'

type DeriveRuntimeState = (runtime: TaskRuntimeState) => TaskRuntimeDerivedState

interface ApplyLifecycleStatusParams {
  state: TaskMachineInternalState
  taskStatus: ApiTaskStatus
  updatedAt?: string
  deriveRuntimeState: DeriveRuntimeState
}

interface ApplyLifecycleStatusResult {
  state: TaskMachineInternalState
  clearPendingChunks: boolean
}

export function applyTaskLifecycleStatusToState({
  state,
  taskStatus,
  updatedAt,
  deriveRuntimeState,
}: ApplyLifecycleStatusParams): ApplyLifecycleStatusResult {
  if (shouldDeferLifecycleStatus(state, taskStatus)) {
    const runtime: TaskRuntimeState = {
      ...state.runtime,
      deferredTerminalStatus: taskStatus,
      deferredTerminalUpdatedAt: updatedAt,
    }
    return {
      state: {
        ...state,
        runtime,
        derived: deriveRuntimeState(runtime),
      },
      clearPendingChunks: false,
    }
  }

  if (shouldIgnoreLifecycleStatus(state, taskStatus, updatedAt)) {
    return { state, clearPendingChunks: false }
  }

  const isTerminal = isTerminalTaskStatus(taskStatus)
  const activeStreamSubtaskId = isTerminal ? undefined : state.runtime.activeStreamSubtaskId
  const phase = getRuntimePhaseForTaskStatus(taskStatus, Boolean(activeStreamSubtaskId))
  const runtime: TaskRuntimeState = {
    ...state.runtime,
    taskId: state.taskId,
    taskStatus,
    phase,
    activeStreamSubtaskId,
    activeStreamStartedAt: isTerminal ? undefined : state.runtime.activeStreamStartedAt,
    activeStreamLastActivityAt: isTerminal ? undefined : state.runtime.activeStreamLastActivityAt,
    lastStatusUpdatedAt: updatedAt ?? state.runtime.lastStatusUpdatedAt,
    lastTerminalStatusUpdatedAt: isTerminal
      ? (updatedAt ?? state.runtime.lastTerminalStatusUpdatedAt)
      : state.runtime.lastTerminalStatusUpdatedAt,
    hasTerminalStatus: isTerminal ? true : state.runtime.hasTerminalStatus,
    deferredTerminalStatus:
      isTerminal || isActiveExecutionTaskStatus(taskStatus)
        ? undefined
        : state.runtime.deferredTerminalStatus,
    deferredTerminalUpdatedAt:
      isTerminal || isActiveExecutionTaskStatus(taskStatus)
        ? undefined
        : state.runtime.deferredTerminalUpdatedAt,
    serverConfirmedNoStream: isTerminal ? false : state.runtime.serverConfirmedNoStream,
  }

  const messages = isTerminal
    ? finalizeStreamingMessagesForTerminal(state.messages, taskStatus)
    : state.messages
  const shouldPreserveMessageRecoveryPhase =
    isTerminal &&
    (state.status === 'waiting_socket' || state.status === 'joining' || state.status === 'syncing')

  return {
    state: {
      ...state,
      status: isTerminal && !shouldPreserveMessageRecoveryPhase ? 'ready' : state.status,
      isStopping: isTerminal ? false : state.isStopping,
      messages,
      runtime,
      derived: deriveRuntimeState(runtime),
    },
    clearPendingChunks: isTerminal,
  }
}

function shouldIgnoreLifecycleStatus(
  state: TaskMachineInternalState,
  taskStatus: ApiTaskStatus,
  updatedAt?: string
): boolean {
  const previousUpdatedAt = state.runtime.lastStatusUpdatedAt
  const previousStatus = state.runtime.taskStatus

  if (isTerminalTaskStatus(previousStatus) && isActiveExecutionTaskStatus(taskStatus)) {
    return true
  }

  if (previousUpdatedAt && updatedAt) {
    const previousTime = Date.parse(previousUpdatedAt)
    const nextTime = Date.parse(updatedAt)
    if (!Number.isNaN(previousTime) && !Number.isNaN(nextTime)) {
      if (nextTime < previousTime) return true
      if (
        nextTime === previousTime &&
        isTerminalTaskStatus(taskStatus) &&
        updatedAt === state.runtime.lastTerminalStatusUpdatedAt &&
        state.runtime.phase === 'streaming' &&
        state.runtime.activeStreamSubtaskId !== undefined
      ) {
        return true
      }
    }
  }

  return false
}

function shouldDeferLifecycleStatus(
  state: TaskMachineInternalState,
  taskStatus: ApiTaskStatus
): boolean {
  return (
    isTerminalTaskStatus(taskStatus) &&
    state.runtime.phase === 'streaming' &&
    state.runtime.activeStreamSubtaskId !== undefined &&
    state.runtime.hasTerminalStatus === true &&
    !state.runtime.lastTerminalStatusUpdatedAt
  )
}

function finalizeStreamingMessagesForTerminal(
  currentMessages: Map<string, UnifiedMessage>,
  taskStatus: ApiTaskStatus
): Map<string, UnifiedMessage> {
  const messages = new Map(currentMessages)
  const finalMessageStatus: MessageStatus =
    taskStatus === 'FAILED' || taskStatus === 'CANCELLED' ? 'error' : 'completed'
  const finalSubtaskStatus =
    taskStatus === 'FAILED' || taskStatus === 'CANCELLED' ? taskStatus : 'COMPLETED'

  messages.forEach((message, id) => {
    if (message.type !== 'ai' || message.status !== 'streaming') return
    messages.set(id, {
      ...message,
      status: finalMessageStatus,
      subtaskStatus: finalSubtaskStatus,
      isReasoningStreaming: false,
    })
  })

  return messages
}
