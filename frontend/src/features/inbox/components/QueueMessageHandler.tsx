// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { getQueueMessage, updateMessageStatus, type QueueMessage } from '@/apis/work-queue'
import { subtaskApis } from '@/apis/subtasks'
import type { QueueMessageContext } from '@/types/context'
import type { TaskDetailSubtask } from '@/types/api'

interface QueueMessageHandlerProps {
  /** Callback to add queue message context(s) to the chat input */
  onQueueMessageLoaded: (contexts: QueueMessageContext[]) => void
}

/**
 * Build QueueMessageContext from a QueueMessage
 */
function buildQueueMessageContext(message: QueueMessage): QueueMessageContext {
  // Build the full content for AI processing
  let fullContent = ''

  // Add sender info
  if (message.sender?.userName) {
    fullContent += `[来自 ${message.sender.userName} 的消息]\n\n`
  }

  // Add note if present
  if (message.note) {
    fullContent += `备注: ${message.note}\n\n`
  }

  // Add message content from snapshot
  // Add message content from snapshot
  if (message.contentSnapshot && message.contentSnapshot.length > 0) {
    fullContent += '--- 原始消息 ---\n\n'
    for (const snapshot of message.contentSnapshot) {
      // Support both uppercase (USER) and lowercase (user) role values
      const isUserRole = snapshot.role?.toUpperCase() === 'USER'
      const role = isUserRole ? '用户' : 'AI'
      const sender = snapshot.senderUserName ? ` (${snapshot.senderUserName})` : ''
      fullContent += `[${role}${sender}]:\n${snapshot.content}\n\n`
    }
  }
  // Build content preview (truncated)
  let contentPreview = ''
  if (message.contentSnapshot && message.contentSnapshot.length > 0) {
    const firstMessage = message.contentSnapshot[0]
    contentPreview = firstMessage.content.slice(0, 100)
    if (firstMessage.content.length > 100) {
      contentPreview += '...'
    }
  }

  return {
    id: message.id,
    name: message.note || `来自 ${message.sender?.userName || '未知用户'} 的消息`,
    type: 'queue_message',
    senderName: message.sender?.userName || '未知用户',
    note: message.note,
    contentPreview,
    fullContent: fullContent.trim(),
    messageCount: message.contentSnapshot?.length || 0,
    sourceTaskId: message.sourceTaskId,
  }
}

/**
 * Build QueueMessageContext from subtasks (for forward to chat feature)
 */
function buildContextFromSubtasks(
  subtasks: TaskDetailSubtask[],
  taskId: number
): QueueMessageContext {
  // Build the full content for AI processing
  let fullContent = '--- 转发的消息 ---\n\n'

  for (const subtask of subtasks) {
    // Support both uppercase (USER) and lowercase (user) role values
    const isUserRole = subtask.role?.toUpperCase() === 'USER'
    const role = isUserRole ? '用户' : 'AI'
    // For group chat, use sender_user_name; for regular chat, just show role
    const sender = subtask.sender_user_name ? ` (${subtask.sender_user_name})` : ''
    const content = isUserRole ? subtask.prompt : (subtask.result?.value as string) || ''
    if (content) {
      fullContent += `[${role}${sender}]:\n${content}\n\n`
    }
  }

  // Build content preview (truncated)
  let contentPreview = ''
  if (subtasks.length > 0) {
    const firstSubtask = subtasks[0]
    const isFirstUserRole = firstSubtask.role?.toUpperCase() === 'USER'
    const firstContent = isFirstUserRole
      ? firstSubtask.prompt
      : (firstSubtask.result?.value as string) || ''
    contentPreview = firstContent.slice(0, 100)
    if (firstContent.length > 100) {
      contentPreview += '...'
    }
  }

  // For "Start Chat" feature, we don't need to show sender name
  // since this is the user's own forwarded message
  return {
    id: taskId, // Use taskId as a unique identifier
    name: `转发的消息 (${subtasks.length} 条)`,
    type: 'queue_message',
    senderName: '我', // Use "我" (me) since user is forwarding their own conversation
    note: undefined,
    contentPreview,
    fullContent: fullContent.trim(),
    messageCount: subtasks.length,
    sourceTaskId: taskId,
  }
}

/**
 * QueueMessageHandler Component
 *
 * Handles the `process_message` URL parameter from inbox page.
 * When a user clicks "Process" on a queue message, they are redirected to
 * /chat?process_message={messageId} or /chat?process_message={id1,id2,id3} for batch.
 *
 * Also handles `forwardTaskId` and `forwardSubtaskIds` parameters for the
 * "Start Chat" feature in the forward dialog.
 *
 * This component:
 *
 * 1. Detects the process_message parameter (supports comma-separated IDs for batch)
 * 2. Fetches the queue message(s) content
 * 3. Creates QueueMessageContext(s) and passes them to the parent via callback
 * 4. Updates the message status to 'read'
 * 5. Removes the parameter from URL to prevent re-processing on refresh
 *
 * For forwardTaskId/forwardSubtaskIds:
 * 1. Fetches the subtasks from the source task
 * 2. Filters by subtaskIds if provided
 * 3. Creates QueueMessageContext and passes to parent
 * 4. Removes the parameters from URL
 */
export function QueueMessageHandler({ onQueueMessageLoaded }: QueueMessageHandlerProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const processedRef = useRef(false)
  const forwardProcessedRef = useRef(false)
  const onQueueMessageLoadedRef = useRef(onQueueMessageLoaded)
  onQueueMessageLoadedRef.current = onQueueMessageLoaded

  const handleProcessMessages = useCallback(
    async (processMessageIds: string) => {
      try {
        // Parse message IDs (supports comma-separated for batch processing)
        const messageIds = processMessageIds
          .split(',')
          .map(id => parseInt(id.trim(), 10))
          .filter(id => !isNaN(id))

        if (messageIds.length === 0) {
          console.error('Invalid process_message IDs:', processMessageIds)
          return
        }

        // Fetch all messages in parallel
        const messagePromises = messageIds.map(id => getQueueMessage(id))
        const messages = await Promise.all(messagePromises)

        // Build contexts for all messages
        const contexts = messages.map(buildQueueMessageContext)

        // Pass all contexts to parent
        onQueueMessageLoadedRef.current(contexts)

        // Update all message statuses to 'read' in parallel
        const statusPromises = messageIds.map(async id => {
          try {
            await updateMessageStatus(id, 'read')
          } catch (statusError) {
            console.error(`Failed to update message ${id} status:`, statusError)
            // Continue even if status update fails
          }
        })
        await Promise.all(statusPromises)

        // Remove the process_message parameter from URL
        const newParams = new URLSearchParams(searchParams.toString())
        newParams.delete('process_message')
        const newUrl = newParams.toString() ? `/chat?${newParams.toString()}` : '/chat'
        router.replace(newUrl)
      } catch (error) {
        console.error('Failed to process queue message(s):', error)
        // Remove the parameter even on error to prevent infinite retry
        const newParams = new URLSearchParams(searchParams.toString())
        newParams.delete('process_message')
        const newUrl = newParams.toString() ? `/chat?${newParams.toString()}` : '/chat'
        router.replace(newUrl)
      }
    },
    [searchParams, router]
  )

  const handleForwardToChat = useCallback(
    async (forwardTaskId: string, forwardSubtaskIds?: string) => {
      try {
        const taskId = parseInt(forwardTaskId, 10)
        if (isNaN(taskId)) {
          console.error('Invalid forwardTaskId:', forwardTaskId)
          return
        }

        // Parse subtask IDs if provided
        const subtaskIds = forwardSubtaskIds
          ? forwardSubtaskIds
              .split(',')
              .map(id => parseInt(id.trim(), 10))
              .filter(id => !isNaN(id))
          : []

        // Fetch subtasks from the source task
        const response = await subtaskApis.listSubtasks({
          taskId,
          limit: 100, // Get enough messages
          fromLatest: true,
        })

        let subtasks = response.items

        // Filter by subtaskIds if provided
        if (subtaskIds.length > 0) {
          subtasks = subtasks.filter(s => subtaskIds.includes(s.id))
        }

        if (subtasks.length === 0) {
          console.error('No subtasks found for forward')
          return
        }

        // Sort subtasks by id to maintain order
        subtasks.sort((a, b) => a.id - b.id)

        // Build context from subtasks
        const context = buildContextFromSubtasks(subtasks, taskId)

        // Pass context to parent
        onQueueMessageLoadedRef.current([context])

        // Remove the forward parameters from URL
        const newParams = new URLSearchParams(searchParams.toString())
        newParams.delete('forwardTaskId')
        newParams.delete('forwardSubtaskIds')
        const newUrl = newParams.toString() ? `/chat?${newParams.toString()}` : '/chat'
        router.replace(newUrl)
      } catch (error) {
        console.error('Failed to process forward to chat:', error)
        // Remove the parameters even on error to prevent infinite retry
        const newParams = new URLSearchParams(searchParams.toString())
        newParams.delete('forwardTaskId')
        newParams.delete('forwardSubtaskIds')
        const newUrl = newParams.toString() ? `/chat?${newParams.toString()}` : '/chat'
        router.replace(newUrl)
      }
    },
    [searchParams, router]
  )

  useEffect(() => {
    const processMessageIds = searchParams.get('process_message')

    // Skip if no process_message parameter or already processed
    if (!processMessageIds || processedRef.current) {
      return
    }

    processedRef.current = true
    handleProcessMessages(processMessageIds)
  }, [searchParams, handleProcessMessages])

  useEffect(() => {
    const forwardTaskId = searchParams.get('forwardTaskId')
    const forwardSubtaskIds = searchParams.get('forwardSubtaskIds')

    // Skip if no forwardTaskId parameter or already processed
    if (!forwardTaskId || forwardProcessedRef.current) {
      return
    }

    forwardProcessedRef.current = true
    handleForwardToChat(forwardTaskId, forwardSubtaskIds || undefined)
  }, [searchParams, handleForwardToChat])

  // This component doesn't render anything
  return null
}
