// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskDetailSubtask } from '@/types/api'
import type {
  Event,
  StreamingRecoveryPayload,
  TaskMachineInternalState,
} from './TaskStateMachine.types'

type RecoverEvent = Extract<Event, { type: 'RECOVER' }>

export interface RecoverJoinOptions {
  forceRefresh: boolean
  afterMessageId?: number
  resumeFromCursor?: number
  activeStreamSubtaskId?: number
}

export function buildRecoverJoinOptions(
  state: TaskMachineInternalState,
  event: RecoverEvent
): { joinOptions: RecoverJoinOptions; maxMessageId?: number } {
  const maxMessageId = getMaxMessageId(state)
  const joinOptions: RecoverJoinOptions = {
    forceRefresh: true,
    afterMessageId: event.syncAfterMessageId ?? maxMessageId,
  }

  if (event.resumeFromCursor !== undefined) {
    joinOptions.resumeFromCursor = event.resumeFromCursor
  }
  if (event.activeStreamSubtaskId !== undefined) {
    joinOptions.activeStreamSubtaskId = event.activeStreamSubtaskId
  }

  return { joinOptions, maxMessageId }
}

export function logRecoverJoinAck({
  state,
  maxMessageId,
  subtasks,
  streaming,
}: {
  state: TaskMachineInternalState
  maxMessageId?: number
  subtasks?: TaskDetailSubtask[]
  streaming?: StreamingRecoveryPayload
}): void {
  const messageIds = Array.isArray(subtasks)
    ? subtasks
        .map(subtask => subtask.message_id)
        .filter((messageId): messageId is number => typeof messageId === 'number')
    : []

  console.info('[TaskStateMachine] recover join ack', {
    taskId: state.taskId,
    maxMessageId,
    messagesBeforeSync: state.messages.size,
    subtasksCount: Array.isArray(subtasks) ? subtasks.length : null,
    firstMessageId: messageIds[0],
    lastMessageId: messageIds[messageIds.length - 1],
    hasStreaming: Boolean(streaming),
    streamRecoverySubtaskId: streaming?.subtask_id,
  })
}

function getMaxMessageId(state: TaskMachineInternalState): number | undefined {
  let maxMessageId: number | undefined
  for (const msg of state.messages.values()) {
    if (
      msg.messageId !== undefined &&
      (maxMessageId === undefined || msg.messageId > maxMessageId)
    ) {
      maxMessageId = msg.messageId
    }
  }

  return maxMessageId
}
