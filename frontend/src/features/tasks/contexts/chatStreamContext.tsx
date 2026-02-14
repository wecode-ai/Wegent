// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Global Chat Stream Context
 *
 * This context manages WebSocket event routing to TaskStateMachine instances.
 * It handles:
 * - Sending chat messages
 * - Stopping streams
 * - Routing WebSocket events (chat:start, chat:chunk, etc.) to the correct TaskStateMachine
 * - Skill event handling (mermaid diagrams, etc.)
 *
 * Key Design: DELEGATE TO STATE MACHINE
 * All message state management is delegated to TaskStateMachine instances.
 * This context is only responsible for:
 * 1. WebSocket event routing
 * 2. Sending messages via WebSocket
 * 3. Managing temp-to-real task ID mapping
 */

import React, { createContext, useContext, useCallback, useRef, useEffect, ReactNode } from 'react'
import { useSocket, ChatEventHandlers, SkillEventHandlers } from '@/contexts/SocketContext'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import {
  ChatSendPayload,
  ChatStartPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatCancelledPayload,
  ChatMessagePayload,
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
  SkillRequestPayload,
  SkillResponsePayload,
} from '@/types/socket'
import type { TaskDetailSubtask, Team } from '@/types/api'
import type { MessageBlock } from '../components/message/thinking/types'
import { taskStateManager, generateMessageId, UnifiedMessage } from '../state'
import DOMPurify from 'dompurify'

/**
 * Message type enum (re-exported for backward compatibility)
 */
export type MessageType = 'user' | 'ai'

/**
 * Message status enum (re-exported for backward compatibility)
 */
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'error'

// Re-export UnifiedMessage for backward compatibility
export type { UnifiedMessage }

/**
 * Request parameters for sending a chat message
 */
export interface ChatMessageRequest {
  /** User message */
  message: string
  /** Team ID */
  team_id: number
  /** Task ID for multi-turn conversations (optional) */
  task_id?: number
  /** Custom title for new tasks (optional) */
  title?: string
  /** Model ID override (optional) */
  model_id?: string
  /** Force override bot's default model */
  force_override_bot_model?: boolean
  /** Model type for override (public/user/group) */
  force_override_bot_model_type?: string
  /** Attachment ID for file upload (optional, deprecated - use attachment_ids) */
  attachment_id?: number
  /** Attachment IDs for multiple file uploads (optional) */
  attachment_ids?: number[]
  /** Enable web search for this message */
  enable_web_search?: boolean
  /** Search engine to use (when web search is enabled) */
  search_engine?: string
  /** Enable clarification mode for this message */
  enable_clarification?: boolean
  /** Enable deep thinking mode for this message */
  enable_deep_thinking?: boolean
  /** Mark this as a group chat task */
  is_group_chat?: boolean
  /** Context items (knowledge bases, etc.) */
  contexts?: Array<{
    type: string
    data: Record<string, unknown>
  }>
  // Repository info for code tasks
  git_url?: string
  git_repo?: string
  git_repo_id?: number
  git_domain?: string
  branch_name?: string
  task_type?: 'chat' | 'code' | 'knowledge' | 'task'
  // Knowledge base ID for knowledge type tasks
  knowledge_base_id?: number
  // Local device ID for task execution (optional, when undefined use cloud executor)
  device_id?: string

  // Skill selection
  /** Skill names to preload (for Chat Shell - prompts injected into system message) */
  preload_skill_names?: string[]
  /** Additional skill names (for other shells - downloaded to executor) */
  additional_skill_names?: string[]
  /** Additional skills with full info (name, namespace, is_public) - preferred over additional_skill_names */
  additional_skills?: Array<{
    name: string
    namespace: string
    is_public: boolean
  }>
  /** Action type. 'pipeline:confirm' for pipeline stage confirmation */
  action?: 'pipeline:confirm' | string
}

/**
 * Context type for chat stream management
 */
interface ChatStreamContextType {
  /** Check if a task is currently streaming */
  isTaskStreaming: (taskId: number) => boolean
  /** Get all currently streaming task IDs */
  getStreamingTaskIds: () => number[]
  /** Send a chat message (returns task ID) */
  sendMessage: (
    request: ChatMessageRequest,
    options?: {
      /** Local message ID from caller's message queue for precise update */
      localMessageId?: string
      pendingUserMessage?: string
      pendingAttachment?: unknown
      pendingAttachments?: unknown[]
      /** Pending contexts for immediate display (attachments, knowledge bases, etc.) */
      pendingContexts?: unknown[]
      onError?: (error: Error) => void
      /** Callback when message is sent, passes back localMessageId for precise update */
      onMessageSent?: (localMessageId: string, taskId: number, subtaskId: number) => void
      /** Temporary task ID for immediate UI feedback (for new tasks) */
      immediateTaskId?: number
      /** Current user ID for group chat sender info */
      currentUserId?: number
      /** Current user name for group chat sender info */
      currentUserName?: string
    }
  ) => Promise<number>
  /**
   * Stop the stream for a specific task
   * @param taskId - Task ID
   * @param backupSubtasks - Optional backup subtasks from selectedTaskDetail
   * @param team - Optional team info for fallback shell_type
   */
  stopStream: (taskId: number, backupSubtasks?: TaskDetailSubtask[], team?: Team) => Promise<void>
  /** Reset stream state for a specific task */
  resetStream: (taskId: number) => void
  /** Clear all stream states */
  clearAllStreams: () => void
  /** Clean up messages after editing (remove edited message and all subsequent messages) */
  cleanupMessagesAfterEdit: (taskId: number, editedSubtaskId: number) => void
  /** Version number that increments when clearAllStreams is called */
  clearVersion: number
}

// Export the context for components that need optional access
export const ChatStreamContext = createContext<ChatStreamContextType | undefined>(undefined)

/**
 * Provider component for chat stream context
 */
export function ChatStreamProvider({ children }: { children: ReactNode }) {
  // Version number that increments when clearAllStreams is called
  const [clearVersion, setClearVersion] = React.useState(0)

  // Get socket context
  const {
    isConnected,
    sendChatMessage,
    cancelChatStream,
    registerChatHandlers,
    registerSkillHandlers,
    sendSkillResponse,
    joinTask,
  } = useSocket()

  // Refs for callbacks (don't need to trigger re-renders)
  const callbacksRef = useRef<
    Map<
      number,
      {
        onError?: (error: Error) => void
        localMessageId?: string
        onMessageSent?: (localMessageId: string, taskId: number, subtaskId: number) => void
      }
    >
  >(new Map())

  // Ref to track temporary task ID to real task ID mapping
  const tempToRealTaskIdRef = useRef<Map<number, number>>(new Map())
  // Ref to track isConnected state for TaskStateManager initialization
  const isConnectedRef = useRef(isConnected)
  useEffect(() => {
    isConnectedRef.current = isConnected
  }, [isConnected])

  // Initialize TaskStateManager with dependencies on mount
  useEffect(() => {
    if (!taskStateManager.isInitialized()) {
      taskStateManager.initialize({
        joinTask: joinTask,
        isConnected: () => isConnectedRef.current,
      })
    }
  }, [joinTask])

  // Page visibility recovery: recover all tasks when page becomes visible after being hidden
  // This handles the case where WebSocket events might have been missed while the page was in background
  usePageVisibility({
    minHiddenTime: 3000, // Recover if page was hidden for more than 3 seconds
    onVisible: (_: number) => {
      if (taskStateManager.isInitialized() && isConnected) {
        taskStateManager.recoverAll().catch(err => {
          console.error('[ChatStreamContext] Error recovering tasks after page visible:', err)
        })
      }
    },
  })

  /**
   * Check if a task is currently streaming
   */
  const isTaskStreaming = useCallback((taskId: number): boolean => {
    const machine = taskStateManager.get(taskId)
    if (!machine) return false
    return machine.getState().status === 'streaming'
  }, [])

  /**
   * Get all currently streaming task IDs
   */
  const getStreamingTaskIds = useCallback((): number[] => {
    return taskStateManager.getStreamingTaskIds()
  }, [])

  /**
   * Handle chat:start event from WebSocket
   */
  const handleChatStart = useCallback((data: ChatStartPayload) => {
    const { task_id, subtask_id, shell_type, message_id } = data

    // Get or create state machine and dispatch event
    const machine = taskStateManager.getOrCreate(task_id)
    machine.handleChatStart(subtask_id, shell_type, message_id)
  }, [])

  /**
   * Handle chat:chunk event from WebSocket
   * Uses task_id from event payload directly (no subtaskToTaskRef needed)
   */
  const handleChatChunk = useCallback((data: ChatChunkPayload) => {
    const { subtask_id, content, result, sources, block_id, task_id: taskId } = data

    if (!taskId) {
      console.warn('[ChatStreamContext] Received chunk without task_id:', subtask_id)
      return
    }

    // Get or create state machine (handles page refresh recovery)
    const machine = taskStateManager.getOrCreate(taskId)
    machine.handleChatChunk(
      subtask_id,
      content,
      result as UnifiedMessage['result'],
      sources,
      block_id
    )
  }, [])

  /**
   * Handle chat:done event from WebSocket
   * Uses task_id from event payload directly
   */
  const handleChatDone = useCallback((data: ChatDonePayload) => {
    const { task_id: taskId, subtask_id, result, message_id, sources } = data

    if (!taskId) {
      console.warn('[ChatStreamContext][chat:done] Missing task_id for subtask:', subtask_id)
      return
    }

    const finalContent = (result?.value as string) || ''
    const hasError = result?.error !== undefined
    const errorMessage = hasError ? (result.error as string) : undefined

    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatDone(
        subtask_id,
        finalContent,
        result as UnifiedMessage['result'],
        message_id,
        sources || (result?.sources as UnifiedMessage['sources']),
        hasError,
        errorMessage
      )
    }
  }, [])

  /**
   * Handle chat:error event from WebSocket
   * Uses task_id from event payload directly
   */
  const handleChatError = useCallback((data: ChatErrorPayload) => {
    const { subtask_id, error, message_id, task_id: taskId } = data

    if (!taskId) {
      console.warn('[ChatStreamContext] Received error without task_id:', subtask_id)
      return
    }

    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatError(subtask_id, error, message_id)
    }

    // Call error callback
    const callbacks = callbacksRef.current.get(taskId)
    callbacks?.onError?.(new Error(error))

    console.error('[ChatStreamContext][chat:error]', { task_id: taskId, subtask_id, error })
  }, [])

  /**
   * Handle chat:cancelled event from WebSocket
   * Uses task_id from event payload directly
   */
  const handleChatCancelled = useCallback((data: ChatCancelledPayload) => {
    const { task_id: taskId, subtask_id } = data

    if (!taskId) {
      console.warn('[ChatStreamContext] Received cancelled without task_id:', subtask_id)
      return
    }

    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatCancelled(subtask_id)
    }
  }, [])

  /**
   * Handle chat:message event from WebSocket (group chat)
   * Uses task_id from event payload directly
   */
  const handleChatMessage = useCallback((data: ChatMessagePayload) => {
    const {
      task_id: taskId,
      subtask_id,
      message_id,
      role,
      content,
      sender,
      created_at,
      attachments,
      contexts,
    } = data

    // Get or create state machine
    const machine = taskStateManager.getOrCreate(taskId)

    // Generate message ID based on role
    const isUserMessage = role === 'user' || role?.toUpperCase() === 'USER'
    const msgId = isUserMessage ? `user-backend-${subtask_id}` : `ai-${subtask_id}`

    // Check if message already exists
    const existingState = machine.getState()
    if (existingState.messages.has(msgId)) {
      return
    }

    // Add message directly to state machine
    const newMessage: UnifiedMessage = {
      id: msgId,
      type: isUserMessage ? 'user' : 'ai',
      status: 'completed',
      content: content || '',
      timestamp: created_at ? new Date(created_at).getTime() : Date.now(),
      subtaskId: subtask_id,
      messageId: message_id,
      senderUserName: sender?.user_name,
      senderUserId: sender?.user_id,
      shouldShowSender: isUserMessage,
      attachments: attachments,
      contexts: contexts,
    }

    machine.addUserMessage(newMessage)
  }, [])

  /**
   * Handle chat:block_created event from WebSocket
   * Uses task_id from event payload directly
   */
  const handleBlockCreated = useCallback((data: ChatBlockCreatedPayload) => {
    const { task_id: taskId, subtask_id, block } = data

    if (!taskId) {
      console.warn('[ChatStreamContext][block_created] Missing task_id for subtask:', subtask_id)
      return
    }

    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatChunk(
        subtask_id,
        '',
        { blocks: [block as MessageBlock] },
        undefined,
        undefined
      )
    }
  }, [])

  /**
   * Handle chat:block_updated event from WebSocket
   * Uses task_id from event payload directly
   */
  const handleBlockUpdated = useCallback((data: ChatBlockUpdatedPayload) => {
    const { task_id: taskId, subtask_id, block_id, content, tool_output, status } = data

    if (!taskId) {
      console.warn('[ChatStreamContext][block_updated] Missing task_id for subtask:', subtask_id)
      return
    }

    // Build partial block update
    const blockUpdate: Partial<MessageBlock> = {
      id: block_id,
      ...(content !== undefined && { content }),
      ...(tool_output !== undefined && { tool_output }),
      ...(status !== undefined && { status }),
    }

    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatChunk(
        subtask_id,
        '',
        { blocks: [blockUpdate as MessageBlock] },
        undefined,
        undefined
      )
    }
  }, [])

  // Register WebSocket event handlers
  useEffect(() => {
    const handlers: ChatEventHandlers = {
      onChatStart: handleChatStart,
      onChatChunk: handleChatChunk,
      onChatDone: handleChatDone,
      onChatError: handleChatError,
      onChatCancelled: handleChatCancelled,
      onChatMessage: handleChatMessage,
      onBlockCreated: handleBlockCreated,
      onBlockUpdated: handleBlockUpdated,
    }

    const cleanup = registerChatHandlers(handlers)
    return cleanup
  }, [
    registerChatHandlers,
    handleChatStart,
    handleChatChunk,
    handleChatDone,
    handleChatError,
    handleChatCancelled,
    handleChatMessage,
    handleBlockCreated,
    handleBlockUpdated,
  ])

  /**
   * Handle skill:request event from WebSocket
   */
  const handleSkillRequest = useCallback(
    async (data: SkillRequestPayload) => {
      const { request_id, skill_name, action } = data

      const basePayload: Pick<SkillResponsePayload, 'request_id' | 'skill_name' | 'action'> = {
        request_id,
        skill_name,
        action,
      }

      if (skill_name === 'mermaid-diagram' && action === 'render') {
        const { code, diagram_type, title } = data.data as {
          code: string
          diagram_type?: string
          title?: string
        }

        try {
          const mermaid = (await import('mermaid')).default

          mermaid.initialize({
            startOnLoad: false,
            suppressErrorRendering: true,
            theme: 'base' as const,
            themeVariables: {
              primaryColor: '#f8fafc',
              primaryTextColor: '#0f172a',
              primaryBorderColor: '#94a3b8',
              lineColor: '#64748b',
              secondaryColor: '#f1f5f9',
              tertiaryColor: '#e2e8f0',
              background: '#ffffff',
              mainBkg: '#f8fafc',
              secondBkg: '#f1f5f9',
              mainContrastColor: '#0f172a',
              darkTextColor: '#0f172a',
              textColor: '#0f172a',
              labelTextColor: '#0f172a',
              signalTextColor: '#0f172a',
              actorBkg: '#f8fafc',
              actorBorder: '#14b8a6',
              actorTextColor: '#0f172a',
              actorLineColor: '#cbd5e1',
              noteBkgColor: '#fef9c3',
              noteBorderColor: '#fbbf24',
              noteTextColor: '#1e293b',
              activationBkgColor: '#e0f2fe',
              activationBorderColor: '#0ea5e9',
              sequenceNumberColor: '#ffffff',
            },
            securityLevel: 'strict' as const,
            flowchart: {
              useMaxWidth: true,
              htmlLabels: true,
              curve: 'basis' as const,
              padding: 15,
            },
            sequence: {
              diagramMarginX: 50,
              diagramMarginY: 20,
              actorMargin: 80,
              width: 180,
              height: 65,
              boxMargin: 10,
              boxTextMargin: 5,
              noteMargin: 15,
              messageMargin: 45,
              mirrorActors: true,
              useMaxWidth: true,
              actorFontSize: 14,
              actorFontWeight: 600,
              noteFontSize: 13,
              messageFontSize: 13,
            },
            fontSize: 14,
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          })

          const renderElementId = `mermaid-render-${request_id}-${Date.now()}`
          const { svg } = await mermaid.render(renderElementId, code)
          const sanitizedSvg = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          })

          sendSkillResponse({ ...basePayload, success: true, result: { svg: sanitizedSvg } })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          let lineNumber: number | undefined
          let columnNumber: number | undefined

          const lineMatch = errorMessage.match(/line\s+(\d+)/i)
          if (lineMatch) lineNumber = parseInt(lineMatch[1], 10)

          const columnMatch = errorMessage.match(/column\s+(\d+)/i)
          if (columnMatch) columnNumber = parseInt(columnMatch[1], 10)

          const errorDetails = [
            `Diagram type: ${diagram_type || 'unknown'}`,
            title ? `Title: ${title}` : null,
            `Code:\n${code}`,
          ]
            .filter(Boolean)
            .join('\n')

          sendSkillResponse({
            ...basePayload,
            success: false,
            error: {
              message: errorMessage,
              line: lineNumber,
              column: columnNumber,
              details: errorDetails,
            },
          })
        }
      } else {
        console.warn('[ChatStreamContext][skill:request] Unknown skill or action:', {
          skill_name,
          action,
        })
        sendSkillResponse({
          ...basePayload,
          success: false,
          error: { message: `Unknown skill or action: ${skill_name}/${action}` },
        })
      }
    },
    [sendSkillResponse]
  )

  // Register skill event handlers
  useEffect(() => {
    const handlers: SkillEventHandlers = { onSkillRequest: handleSkillRequest }
    const cleanup = registerSkillHandlers(handlers)
    return cleanup
  }, [registerSkillHandlers, handleSkillRequest])

  /**
   * Send a chat message via WebSocket
   */
  const sendMessage = useCallback(
    async (
      request: ChatMessageRequest,
      options?: {
        localMessageId?: string
        pendingUserMessage?: string
        pendingAttachment?: unknown
        pendingAttachments?: unknown[]
        pendingContexts?: unknown[]
        onError?: (error: Error) => void
        onMessageSent?: (localMessageId: string, taskId: number, subtaskId: number) => void
        immediateTaskId?: number
        currentUserId?: number
        currentUserName?: string
      }
    ): Promise<number> => {
      if (!isConnected) {
        const error = new Error('WebSocket not connected')
        options?.onError?.(error)
        throw error
      }

      const immediateTaskId = options?.immediateTaskId || request.task_id || -Date.now()
      const userMessageId = options?.localMessageId || generateMessageId('user')

      // Store callbacks
      callbacksRef.current.set(immediateTaskId, {
        onError: options?.onError,
        localMessageId: userMessageId,
        onMessageSent: options?.onMessageSent,
      })

      // Create user message
      const userMessage: UnifiedMessage = {
        id: userMessageId,
        type: 'user',
        status: 'pending',
        content: options?.pendingUserMessage || request.message,
        attachment: options?.pendingAttachment,
        attachments: options?.pendingAttachments,
        contexts: options?.pendingContexts,
        timestamp: Date.now(),
        senderUserName: options?.currentUserName,
        senderUserId: options?.currentUserId,
        shouldShowSender: request.is_group_chat,
      }

      // Add to state machine immediately
      const machine = taskStateManager.getOrCreate(immediateTaskId)
      machine.addUserMessage(userMessage)

      // Convert request to WebSocket payload
      const payload: ChatSendPayload = {
        task_id: request.task_id,
        team_id: request.team_id,
        message: request.message,
        title: request.title,
        attachment_id: request.attachment_id,
        attachment_ids: request.attachment_ids,
        enable_web_search: request.enable_web_search,
        search_engine: request.search_engine,
        enable_clarification: request.enable_clarification,
        enable_deep_thinking: request.enable_deep_thinking,
        force_override_bot_model: request.model_id,
        force_override_bot_model_type: request.force_override_bot_model_type,
        is_group_chat: request.is_group_chat,
        contexts: request.contexts,
        git_url: request.git_url,
        git_repo: request.git_repo,
        git_repo_id: request.git_repo_id,
        git_domain: request.git_domain,
        branch_name: request.branch_name,
        task_type: request.task_type,
        knowledge_base_id: request.knowledge_base_id,
        device_id: request.device_id,
        additional_skills: request.additional_skills,
        action: request.action,
      }

      try {
        const response = await sendChatMessage(payload)

        if (!response) {
          const error = new Error('Failed to send message: no response from server')
          machine.updateUserMessage(userMessageId, { status: 'error', error: error.message })
          options?.onError?.(error)
          throw error
        }

        if (response.error) {
          const error = new Error(response.error)
          machine.updateUserMessage(userMessageId, { status: 'error', error: response.error })
          options?.onError?.(error)
          throw error
        }

        const realTaskId = response.task_id || immediateTaskId
        const subtaskId = response.subtask_id
        const messageId = response.message_id

        // Update user message
        machine.updateUserMessage(userMessageId, {
          status: 'completed',
          subtaskId,
          messageId,
        })

        // Handle task ID migration if needed
        if (realTaskId !== immediateTaskId && realTaskId > 0) {
          // Move callbacks
          const callbacks = callbacksRef.current.get(immediateTaskId)
          if (callbacks) {
            callbacksRef.current.delete(immediateTaskId)
            callbacksRef.current.set(realTaskId, callbacks)
          }
          tempToRealTaskIdRef.current.set(immediateTaskId, realTaskId)

          // Migrate state from temp machine to real machine
          // This ensures user messages added to temp machine are not lost
          taskStateManager.migrateState(immediateTaskId, realTaskId)
        }

        // Join the task room
        if (realTaskId !== immediateTaskId && realTaskId > 0) {
          await joinTask(realTaskId)
        } else if (request.task_id && request.task_id > 0) {
          await joinTask(request.task_id)
        }

        // Callback
        const finalTaskId = realTaskId > 0 ? realTaskId : immediateTaskId
        options?.onMessageSent?.(userMessageId, finalTaskId, subtaskId || 0)

        return realTaskId
      } catch (error) {
        machine.updateUserMessage(userMessageId, {
          status: 'error',
          error: (error as Error).message,
        })
        throw error
      }
    },
    [isConnected, sendChatMessage, joinTask]
  )

  /**
   * Stop the stream for a specific task
   */
  const stopStream = useCallback(
    async (taskId: number, backupSubtasks?: TaskDetailSubtask[], team?: Team): Promise<void> => {
      const machine = taskStateManager.get(taskId)
      if (!machine || machine.getState().status !== 'streaming') {
        return
      }

      machine.setStopping(true)

      const state = machine.getState()
      let subtaskId = state.streamingSubtaskId

      // Find running subtask from backup if needed
      let runningSubtask: TaskDetailSubtask | undefined
      if (!subtaskId && backupSubtasks && backupSubtasks.length > 0) {
        runningSubtask = backupSubtasks
          .filter(st => st.role === 'ASSISTANT' && st.status === 'RUNNING')
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
        if (runningSubtask) {
          subtaskId = runningSubtask.id
        }
      } else if (subtaskId && backupSubtasks) {
        runningSubtask = backupSubtasks.find(st => st.id === subtaskId)
        if (!runningSubtask) {
          runningSubtask = backupSubtasks
            .filter(st => st.role === 'ASSISTANT' && st.status === 'RUNNING')
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
        }
      }

      // Get partial content
      let partialContent = ''
      if (subtaskId) {
        const aiMessageId = generateMessageId('ai', subtaskId)
        const aiMessage = state.messages.get(aiMessageId)
        partialContent = aiMessage?.content || ''
      }

      // Get shell type
      let shellType = runningSubtask?.bots?.[0]?.shell_type
      if (!shellType && team) {
        shellType = team.bots?.[0]?.bot?.shell_type
        if (!shellType && team.agent_type?.toLowerCase() === 'chat') {
          shellType = 'Chat'
        }
      }

      // Call backend to cancel
      if (subtaskId) {
        try {
          const result = await cancelChatStream(subtaskId, partialContent, shellType)
          if (result.error) {
            console.error('[ChatStreamContext] Failed to cancel stream:', result.error)
          }
        } catch (error) {
          console.error('[ChatStreamContext] Exception during cancelChatStream:', error)
        }
      }

      // Update state machine - mark as cancelled
      if (subtaskId) {
        machine.handleChatCancelled(subtaskId)
      }
      machine.setStopping(false)
    },
    [cancelChatStream]
  )

  /**
   * Reset stream state for a specific task
   */
  const resetStream = useCallback((taskId: number): void => {
    taskStateManager.cleanup(taskId)
    callbacksRef.current.delete(taskId)

    // Clean up temp to real mapping
    tempToRealTaskIdRef.current.forEach((realId, tempId) => {
      if (realId === taskId || tempId === taskId) {
        tempToRealTaskIdRef.current.delete(tempId)
      }
    })
  }, [])

  /**
   * Clear all stream states
   */
  const clearAllStreams = useCallback((): void => {
    taskStateManager.cleanupAll()
    callbacksRef.current.clear()
    tempToRealTaskIdRef.current.clear()
    setClearVersion(v => v + 1)
  }, [])

  /**
   * Clean up messages after editing
   */
  const cleanupMessagesAfterEdit = useCallback((taskId: number, editedSubtaskId: number): void => {
    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.cleanupMessagesAfterEdit(editedSubtaskId)
    }
  }, [])

  return (
    <ChatStreamContext.Provider
      value={{
        isTaskStreaming,
        getStreamingTaskIds,
        sendMessage,
        stopStream,
        resetStream,
        clearAllStreams,
        cleanupMessagesAfterEdit,
        clearVersion,
      }}
    >
      {children}
    </ChatStreamContext.Provider>
  )
}

/**
 * Hook to use chat stream context
 */
export function useChatStreamContext(): ChatStreamContextType {
  const context = useContext(ChatStreamContext)
  if (!context) {
    throw new Error('useChatStreamContext must be used within a ChatStreamProvider')
  }
  return context
}

/**
 * Helper function to compute isStreaming from messages (for backward compatibility)
 */
export function computeIsStreaming(messages: Map<string, UnifiedMessage> | undefined): boolean {
  if (!messages) return false
  for (const msg of messages.values()) {
    if (msg.type === 'ai' && msg.status === 'streaming') {
      return true
    }
  }
  return false
}
