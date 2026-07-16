// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskDetailSubtask } from '../api-types'
import { buildMessagesFromSubtasks } from './TaskStateMachine.messageBuilder'
import { generateMessageId } from './TaskStateMachine.messageUtils'
import type {
  MessageStatus,
  StreamingRecoveryPayload,
  SyncOptions,
  TaskMachineInternalState,
  UnifiedMessage,
} from './TaskStateMachine.types'

export type SyncCompletionEvent =
  | { type: 'done'; syncUpdatedAt?: string }
  | {
      type: 'streaming'
      subtaskId: number
      cursor: number
      startedAt?: string
      lastActivityAt?: string
      syncUpdatedAt?: string
    }

interface SyncMessagesParams {
  state: TaskMachineInternalState
  subtasks?: TaskDetailSubtask[]
  syncOptions: SyncOptions
  syncUpdatedAt?: string
  streamRecovery?: StreamingRecoveryPayload
}

interface SyncMessagesResult {
  state: TaskMachineInternalState
  completion: SyncCompletionEvent
}

export function syncMessagesFromJoinPayload({
  state,
  subtasks,
  syncOptions,
  syncUpdatedAt,
  streamRecovery,
}: SyncMessagesParams): SyncMessagesResult {
  let nextState = state

  if (subtasks && subtasks.length > 0) {
    const messagesBefore = nextState.messages.size
    nextState = {
      ...nextState,
      messages: buildMessagesFromSubtasks({
        currentMessages: nextState.messages,
        subtasks,
        syncOptions,
        streamRecovery,
      }),
    }
    console.info('[TaskStateMachine] sync subtasks', {
      taskId: nextState.taskId,
      subtasksCount: subtasks.length,
      messagesBefore,
      messagesAfter: nextState.messages.size,
      status: nextState.status,
    })
  }

  nextState = applyStreamRecoveryMessage(nextState, streamRecovery)

  if (!streamRecovery?.subtask_id) {
    nextState = finalizeStaleStreamingMessagesForNoStream(nextState, subtasks)
  }

  const activeStreamSubtaskId = getActiveStreamSubtaskId(nextState)
  if (activeStreamSubtaskId) {
    const isRecoveredStream = streamRecovery?.subtask_id === activeStreamSubtaskId
    return {
      state: nextState,
      completion: {
        type: 'streaming',
        subtaskId: activeStreamSubtaskId,
        cursor: isRecoveredStream
          ? (streamRecovery.offset ?? streamRecovery.cached_content?.length ?? 0)
          : 0,
        startedAt: isRecoveredStream ? streamRecovery.started_at : undefined,
        lastActivityAt: isRecoveredStream ? streamRecovery.last_activity_at : undefined,
        syncUpdatedAt,
      },
    }
  }

  return {
    state: nextState,
    completion: { type: 'done', syncUpdatedAt },
  }
}

export function finalizeStaleStreamingMessagesForNoStream(
  state: TaskMachineInternalState,
  subtasks?: TaskDetailSubtask[]
): TaskMachineInternalState {
  let nextMessages: Map<string, UnifiedMessage> | null = null

  for (const msg of state.messages.values()) {
    if (msg.type !== 'ai' || msg.status !== 'streaming' || !msg.subtaskId) {
      continue
    }

    const staleSubtask = subtasks?.find(s => s.id === msg.subtaskId)
    const finalStatus: MessageStatus = staleSubtask?.status === 'COMPLETED' ? 'completed' : 'error'
    const staleMsgId = generateMessageId('ai', msg.subtaskId)
    const staleMsg = state.messages.get(staleMsgId)

    if (!staleMsg) {
      continue
    }

    if (!nextMessages) {
      nextMessages = new Map(state.messages)
    }
    nextMessages.set(staleMsgId, {
      ...staleMsg,
      status: finalStatus,
      subtaskStatus: staleSubtask?.status ?? staleMsg.subtaskStatus,
      isReasoningStreaming: false,
    })
  }

  return nextMessages ? { ...state, messages: nextMessages } : state
}

function applyStreamRecoveryMessage(
  state: TaskMachineInternalState,
  streamRecovery?: StreamingRecoveryPayload
): TaskMachineInternalState {
  if (!streamRecovery?.subtask_id) {
    return state
  }

  const aiMessageId = generateMessageId('ai', streamRecovery.subtask_id)
  const existingMessage = state.messages.get(aiMessageId)

  if (!existingMessage) {
    const newMessages = new Map(state.messages)
    newMessages.set(aiMessageId, {
      id: aiMessageId,
      type: 'ai',
      status: 'streaming',
      content: streamRecovery.cached_content || '',
      timestamp: Date.now(),
      subtaskId: streamRecovery.subtask_id,
      result: streamRecovery.blocks?.length ? { blocks: streamRecovery.blocks } : undefined,
    })
    return { ...state, messages: newMessages }
  }

  if (existingMessage.status !== 'streaming') {
    return state
  }

  const shouldUpdateContent =
    streamRecovery.cached_content &&
    streamRecovery.cached_content.length > existingMessage.content.length
  const shouldUpdateBlocks =
    streamRecovery.blocks?.length &&
    (!existingMessage.result?.blocks ||
      streamRecovery.blocks.length > existingMessage.result.blocks.length)

  if (!shouldUpdateContent && !shouldUpdateBlocks) {
    return state
  }

  const newMessages = new Map(state.messages)
  const updatedMessage: UnifiedMessage = { ...existingMessage }

  if (shouldUpdateContent) {
    updatedMessage.content = streamRecovery.cached_content!
  }

  if (shouldUpdateBlocks) {
    updatedMessage.result = {
      ...existingMessage.result,
      blocks: streamRecovery.blocks,
    }
  }

  newMessages.set(aiMessageId, updatedMessage)
  return { ...state, messages: newMessages }
}

function getActiveStreamSubtaskId(state: TaskMachineInternalState): number | null {
  for (const msg of state.messages.values()) {
    if (msg.type === 'ai' && msg.status === 'streaming') {
      return msg.subtaskId || null
    }
  }

  return null
}
