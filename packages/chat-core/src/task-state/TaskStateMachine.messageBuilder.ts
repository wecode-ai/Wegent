// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskDetailSubtask } from '../api-types'
import type {
  MessageStatus,
  StreamingRecoveryPayload,
  SyncOptions,
  UnifiedMessage,
} from './TaskStateMachine.types'

interface BuildMessagesParams {
  currentMessages: Map<string, UnifiedMessage>
  subtasks: TaskDetailSubtask[]
  syncOptions: SyncOptions
  streamRecovery?: StreamingRecoveryPayload
}

/**
 * Build messages from backend subtasks.
 *
 * Content priority for RUNNING AI messages:
 * 1. Redis cached_content (most recent, updated every 1s)
 * 2. Existing message content in state
 * 3. Backend DB subtask.result.value (least recent, updated every 5s)
 */
export function buildMessagesFromSubtasks({
  currentMessages,
  subtasks,
  syncOptions,
  streamRecovery,
}: BuildMessagesParams): Map<string, UnifiedMessage> {
  const { teamName, isGroupChat, currentUserId, currentUserName, forceClean } = syncOptions

  const validSubtaskIds = new Set(subtasks.map(s => s.id))

  let messages: Map<string, UnifiedMessage>
  if (forceClean && currentMessages.size > 0) {
    messages = new Map()
    for (const [msgId, msg] of currentMessages) {
      if (!msg.subtaskId || validSubtaskIds.has(msg.subtaskId)) {
        messages.set(msgId, msg)
      }
    }
  } else {
    messages = new Map(currentMessages)
  }

  const existingSubtaskIds = new Set<number>()
  let existingUserMessageCount = 0
  for (const msg of messages.values()) {
    if (msg.subtaskId) {
      existingSubtaskIds.add(msg.subtaskId)
    }
    if (msg.type === 'user') {
      existingUserMessageCount++
    }
  }

  const incomingUserSubtasks = subtasks.filter(
    s => s.role === 'USER' || s.role?.toUpperCase() === 'USER'
  )

  for (const subtask of subtasks) {
    const isUserMessage = subtask.role === 'USER' || subtask.role?.toUpperCase() === 'USER'
    const messageId = isUserMessage ? `user-backend-${subtask.id}` : `ai-${subtask.id}`

    const existingMessage = currentMessages.get(messageId)
    const hasFrontendError =
      existingMessage && existingMessage.status === 'error' && existingMessage.error
    const subtaskResult = subtask.result as UnifiedMessage['result']

    if (!isUserMessage && subtask.status === 'RUNNING') {
      const existingAiMessage = messages.get(messageId)
      const backendContent = typeof subtaskResult?.value === 'string' ? subtaskResult.value : ''
      let bestContent = backendContent

      if (existingAiMessage && existingAiMessage.content.length > bestContent.length) {
        bestContent = existingAiMessage.content
      }

      if (
        streamRecovery &&
        streamRecovery.subtask_id === subtask.id &&
        streamRecovery.cached_content &&
        streamRecovery.cached_content.length > bestContent.length
      ) {
        bestContent = streamRecovery.cached_content
      }

      messages.set(messageId, {
        id: messageId,
        type: 'ai',
        status: hasFrontendError ? 'error' : 'streaming',
        content: bestContent,
        timestamp: existingAiMessage?.timestamp || new Date(subtask.created_at).getTime(),
        subtaskId: subtask.id,
        messageId: subtask.message_id,
        attachments: subtask.attachments,
        contexts: subtask.contexts,
        botName: subtask.bots?.[0]?.name || teamName,
        subtaskStatus: subtask.status,
        result: subtaskResult,
        error: hasFrontendError ? existingMessage?.error : undefined,
        errorType: hasFrontendError ? existingMessage?.errorType : undefined,
        reasoningContent: existingAiMessage?.reasoningContent,
      })
      continue
    }

    if (!isUserMessage && subtask.status === 'PENDING') {
      continue
    }

    const existingSnapshotMessage = messages.get(messageId)
    if (existingSnapshotMessage && !isUserMessage) {
      const backendContent = typeof subtaskResult?.value === 'string' ? subtaskResult.value : ''
      const nextStatus: MessageStatus =
        subtask.status === 'FAILED' || subtask.status === 'CANCELLED' || hasFrontendError
          ? 'error'
          : 'completed'

      messages.set(messageId, {
        ...existingSnapshotMessage,
        status: nextStatus,
        content:
          backendContent.length > existingSnapshotMessage.content.length
            ? backendContent
            : existingSnapshotMessage.content,
        messageId: subtask.message_id,
        subtaskStatus: subtask.status,
        result: subtaskResult,
        error: hasFrontendError ? existingMessage?.error : subtask.error_message || undefined,
        errorType: hasFrontendError
          ? existingMessage?.errorType
          : ((subtaskResult as Record<string, unknown>)?.error_type as string | undefined),
        isReasoningStreaming: false,
      })
      continue
    }

    if (existingSubtaskIds.has(subtask.id)) {
      continue
    }

    if (messages.has(messageId)) {
      continue
    }

    if (isUserMessage && existingUserMessageCount >= incomingUserSubtasks.length) {
      continue
    }

    let status: MessageStatus = 'completed'
    if (subtask.status === 'FAILED' || subtask.status === 'CANCELLED') {
      status = 'error'
    } else if (hasFrontendError) {
      status = 'error'
    }

    const content = isUserMessage
      ? subtask.prompt || ''
      : typeof subtaskResult?.value === 'string'
        ? subtaskResult.value
        : ''

    const errorField = hasFrontendError
      ? existingMessage?.error
      : subtask.error_message || undefined

    const errorTypeField = hasFrontendError
      ? existingMessage?.errorType
      : ((subtaskResult as Record<string, unknown>)?.error_type as string | undefined)

    messages.set(messageId, {
      id: messageId,
      type: isUserMessage ? 'user' : 'ai',
      status,
      content,
      timestamp: new Date(subtask.created_at).getTime(),
      subtaskId: subtask.id,
      messageId: subtask.message_id,
      attachments: subtask.attachments,
      contexts: subtask.contexts,
      botName: !isUserMessage && subtask.bots?.[0]?.name ? subtask.bots[0].name : teamName,
      senderUserName:
        subtask.sender_user_name ||
        (isUserMessage && subtask.sender_user_id === currentUserId ? currentUserName : undefined),
      senderUserId: subtask.sender_user_id || (isUserMessage ? currentUserId : undefined),
      shouldShowSender: isGroupChat && isUserMessage,
      subtaskStatus: subtask.status,
      result: subtaskResult,
      error: errorField,
      errorType: errorTypeField,
    })
  }

  return messages
}
