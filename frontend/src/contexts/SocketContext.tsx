// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Socket.IO Context Provider
 *
 * React wrapper around the shared SocketClient.
 * Keeps frontend-specific auth handling and business event helpers out of the connection layer.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  ReactNode,
} from 'react'
import { createAuthenticatedSocketClient, type SocketClientSocket } from '@wegent/chat-core'
import { getToken, removeToken } from '@/apis/user'
import {
  ClientEvents,
  ServerEvents,
  ClientSkillEvents,
  ChatStartPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatCancelledPayload,
  ChatStatusUpdatedPayload,
  ChatMessagePayload,
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
  ChatSendPayload,
  ChatSendAck,
  ChatGuidePayload,
  ChatGuideAck,
  ChatGuidanceQueuedPayload,
  ChatGuidanceAppliedPayload,
  ChatGuidanceExpiredPayload,
  TaskCreatedPayload,
  TaskStatusPayload,
  TaskInvitedPayload,
  TaskAppUpdatePayload,
  SkillRequestPayload,
  SkillResponsePayload,
  CorrectionStartPayload,
  CorrectionProgressPayload,
  CorrectionChunkPayload,
  CorrectionDonePayload,
  CorrectionErrorPayload,
  BackgroundExecutionUpdatePayload,
} from '@/types/socket'

import { fetchRuntimeConfig, getSocketUrl } from '@/lib/runtime-config'
import { paths } from '@/config/paths'
import { POST_LOGIN_REDIRECT_KEY } from '@/features/login/constants'

const SOCKETIO_PATH = '/socket.io'

/** Callback type for reconnect event */
export type ReconnectCallback = () => void

interface SocketContextType {
  /** Stable Socket.IO connection facade */
  socket: SocketClientSocket | null
  /** Whether connected to server */
  isConnected: boolean
  /** Connection error if any */
  connectionError: Error | null
  /** Reconnect attempt count */
  reconnectAttempts: number
  /** Connect to Socket.IO server */
  connect: (token: string) => void
  /** Disconnect from server */
  disconnect: () => void
  /** Ensure a disconnected or stale Socket.IO session starts a fresh connection attempt */
  ensureConnected: () => void
  /**
   * Join a task room.
   * @param taskId - Task ID to join
   * @param options - Join options
   * @param options.forceRefresh - If true, always emit task:join to get streaming status
   * @param options.afterMessageId - If provided, only return messages after this ID (for incremental sync)
   */
  joinTask: (
    taskId: number,
    options?: {
      forceRefresh?: boolean
      afterMessageId?: number
    }
  ) => Promise<{
    streaming?: {
      subtask_id: number
      offset: number
      cached_content: string
      started_at?: string
      last_activity_at?: string
    }
    status_updated?: ChatStatusUpdatedPayload
    /** Subtasks data for immediate message sync (same format as task detail API) */
    subtasks?: Array<Record<string, unknown>>
    error?: string
  }>
  /** Leave a task room */
  leaveTask: (taskId: number) => void
  /** Send a chat message via WebSocket */
  sendChatMessage: (payload: ChatSendPayload) => Promise<ChatSendAck>
  /** Send Chat Shell guidance via WebSocket */
  sendChatGuidance: (payload: ChatGuidePayload) => Promise<ChatGuideAck>
  /** Cancel a chat stream via WebSocket */
  cancelChatStream: (
    subtaskId: number,
    partialContent?: string,
    shellType?: string
  ) => Promise<{ success: boolean; error?: string }>
  /** Close a device task session via WebSocket */
  closeTaskSession: (taskId: number) => Promise<{ success: boolean; error?: string }>
  /** Retry a failed message via WebSocket */
  retryMessage: (
    taskId: number,
    subtaskId: number,
    modelId?: string,
    modelType?: string,
    forceOverride?: boolean
  ) => Promise<{ success: boolean; error?: string }>
  /** Register chat event handlers */
  registerChatHandlers: (handlers: ChatEventHandlers) => () => void
  /** Register task event handlers */
  registerTaskHandlers: (handlers: TaskEventHandlers) => () => void
  /** Register skill event handlers */
  registerSkillHandlers: (handlers: SkillEventHandlers) => () => void
  /** Send skill response back to server */
  sendSkillResponse: (payload: SkillResponsePayload) => void
  /** Register correction event handlers */
  registerCorrectionHandlers: (handlers: CorrectionEventHandlers) => () => void
  /** Register background execution event handlers */
  registerBackgroundExecutionHandlers: (handlers: BackgroundExecutionEventHandlers) => () => void
  /** Register a callback to be called when WebSocket reconnects */
  onReconnect: (callback: ReconnectCallback) => () => void
}

/** Chat event handlers for streaming */
export interface ChatEventHandlers {
  onChatStart?: (data: ChatStartPayload) => void
  onChatChunk?: (data: ChatChunkPayload) => void
  onChatDone?: (data: ChatDonePayload) => void
  onChatError?: (data: ChatErrorPayload) => void
  onChatCancelled?: (data: ChatCancelledPayload) => void
  onChatStatusUpdated?: (data: ChatStatusUpdatedPayload) => void
  /** Handler for chat:message event (other users' messages in group chat) */
  onChatMessage?: (data: ChatMessagePayload) => void
  /** Handler for chat:block_created event (new block added) */
  onBlockCreated?: (data: ChatBlockCreatedPayload) => void
  /** Handler for chat:block_updated event (block content/status updated) */
  onBlockUpdated?: (data: ChatBlockUpdatedPayload) => void
  /** Handler for chat:guidance_queued event */
  onGuidanceQueued?: (data: ChatGuidanceQueuedPayload) => void
  /** Handler for chat:guidance_applied event */
  onGuidanceApplied?: (data: ChatGuidanceAppliedPayload) => void
  /** Handler for chat:guidance_expired event */
  onGuidanceExpired?: (data: ChatGuidanceExpiredPayload) => void
}

/** Task event handlers for task list updates */
export interface TaskEventHandlers {
  onTaskCreated?: (data: TaskCreatedPayload) => void
  onTaskInvited?: (data: TaskInvitedPayload) => void
  onTaskStatus?: (data: TaskStatusPayload) => void
  /** Handler for task:app_update event (app preview data updated, sent to task room) */
  onTaskAppUpdate?: (data: TaskAppUpdatePayload) => void
}

/** Skill event handlers for generic skill requests */
export interface SkillEventHandlers {
  /** Handler for skill:request event (server requests frontend to perform a skill action) */
  onSkillRequest?: (data: SkillRequestPayload) => void
}

/** Correction event handlers for cross-validation progress */
export interface CorrectionEventHandlers {
  onCorrectionStart?: (data: CorrectionStartPayload) => void
  onCorrectionProgress?: (data: CorrectionProgressPayload) => void
  onCorrectionChunk?: (data: CorrectionChunkPayload) => void
  onCorrectionDone?: (data: CorrectionDonePayload) => void
  onCorrectionError?: (data: CorrectionErrorPayload) => void
}

/** Background execution event handlers for subscription execution updates */
export interface BackgroundExecutionEventHandlers {
  onBackgroundExecutionUpdate?: (data: BackgroundExecutionUpdatePayload) => void
}

const SocketContext = createContext<SocketContextType | undefined>(undefined)

type SocketEventHandler = (...args: never[]) => void
type SocketHandlerEntry = readonly [event: string, handler: SocketEventHandler | undefined]

function socketHandler<TArgs extends unknown[]>(
  event: string,
  handler: ((...args: TArgs) => void) | undefined
): SocketHandlerEntry {
  return [event, handler as unknown as SocketEventHandler | undefined]
}

function registerSocketHandlers(
  socket: SocketClientSocket,
  entries: SocketHandlerEntry[]
): () => void {
  entries.forEach(([event, handler]) => {
    if (handler) {
      socket.on(event, handler)
    }
  })

  return () => {
    entries.forEach(([event, handler]) => {
      if (handler) {
        socket.off(event, handler)
      }
    })
  }
}

function cacheChatStatusSnapshot(
  cache: React.MutableRefObject<Record<number, ChatStatusUpdatedPayload>>,
  payload: ChatStatusUpdatedPayload
): void {
  cache.current[payload.task_id] = payload
}

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<SocketClientSocket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [connectionError, setConnectionError] = useState<Error | null>(null)
  const [reconnectAttempts, setReconnectAttempts] = useState(0)

  // Track current joined tasks
  const joinedTasksRef = useRef<Set<number>>(new Set())
  const latestChatStatusRef = useRef<Record<number, ChatStatusUpdatedPayload>>({})
  const handleAuthError = useCallback((_error: unknown) => {
    removeToken()

    const loginPath = paths.auth.login.getHref()
    if (typeof window !== 'undefined' && window.location.pathname !== loginPath) {
      const currentPath = window.location.pathname + window.location.search
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, currentPath)
      window.location.href = loginPath
    }
  }, [])

  const socketClient = useMemo(
    () =>
      createAuthenticatedSocketClient({
        socketBaseUrl: async () => {
          const config = await fetchRuntimeConfig()
          return config.socketDirectUrl || getSocketUrl()
        },
        getToken,
        namespace: '/chat',
        path: SOCKETIO_PATH,
        authErrorEvent: ServerEvents.AUTH_ERROR,
        onAuthError: handleAuthError,
        logger: console,
      }),
    [handleAuthError]
  )

  useEffect(() => {
    return socketClient.subscribe(state => {
      setSocket(state.socket ? socketClient.socket : null)
      setIsConnected(state.isConnected)
      setConnectionError(state.connectionError)
      setReconnectAttempts(state.reconnectAttempts)
      if (!state.isConnected) {
        joinedTasksRef.current.clear()
      }
    })
  }, [socketClient])

  const connect = useCallback(
    (token: string, notifyReconnectOnConnect = false) => {
      void socketClient.connect(token, notifyReconnectOnConnect)
    },
    [socketClient]
  )

  const ensureConnected = useCallback(() => {
    void socketClient.ensureConnected()
  }, [socketClient])

  /**
   * Disconnect from server
   */
  const disconnect = useCallback(() => {
    joinedTasksRef.current.clear()
    socketClient.disconnect()
  }, [socketClient])

  /**
   * Join a task room
   * Prevents duplicate joins by checking if already joined
   * @param taskId - The task ID to join
   * @param options - Join options
   * @param options.forceRefresh - If true, always emit task:join to get streaming status
   * @param options.afterMessageId - If provided, only return messages after this ID (for incremental sync)
   */
  const joinTask = useCallback(
    async (
      taskId: number,
      options?: {
        forceRefresh?: boolean
        afterMessageId?: number
      }
    ): Promise<{
      streaming?: {
        subtask_id: number
        offset: number
        cached_content: string
        started_at?: string
        last_activity_at?: string
      }
      status_updated?: ChatStatusUpdatedPayload
      subtasks?: Array<Record<string, unknown>>
      error?: string
    }> => {
      const { forceRefresh = false, afterMessageId } = options || {}

      const currentSocket = socketClient.socket
      if (!currentSocket.connected) {
        return { error: 'Not connected' }
      }

      // Check if already joined this task room to prevent duplicate joins.
      // State-machine recovery passes forceRefresh/afterMessageId, so it never uses
      // this dedupe path for refresh or reconnect recovery.
      const alreadyJoined = joinedTasksRef.current.has(taskId)
      const shouldSkip = alreadyJoined && !forceRefresh && afterMessageId === undefined

      if (shouldSkip) {
        return {}
      }

      // Add to set IMMEDIATELY to prevent concurrent duplicate joins
      // This is crucial because the socket.emit is async and multiple calls
      // could pass the above check before any callback completes
      joinedTasksRef.current.add(taskId)

      // Build payload with optional after_message_id for incremental sync
      const payload: { task_id: number; after_message_id?: number } = { task_id: taskId }
      if (afterMessageId !== undefined) {
        payload.after_message_id = afterMessageId
      }

      return new Promise(resolve => {
        currentSocket.emit(
          'task:join',
          payload,
          (response: {
            streaming?: {
              subtask_id: number
              offset: number
              cached_content: string
              started_at?: string
              last_activity_at?: string
            }
            status_updated?: ChatStatusUpdatedPayload
            subtasks?: Array<Record<string, unknown>>
            error?: string
          }) => {
            const subtasksCount = Array.isArray(response.subtasks) ? response.subtasks.length : null
            const firstSubtask = Array.isArray(response.subtasks) ? response.subtasks[0] : undefined
            const lastSubtask =
              Array.isArray(response.subtasks) && response.subtasks.length > 0
                ? response.subtasks[response.subtasks.length - 1]
                : undefined

            if (response.streaming) {
              console.info('[StreamingJoinDebug] task:join ack', {
                taskId,
                forceRefresh,
                afterMessageId,
                subtasksCount,
                firstMessageId: firstSubtask?.message_id,
                lastMessageId: lastSubtask?.message_id,
                subtaskId: response.streaming.subtask_id,
                startedAt: response.streaming.started_at,
                lastActivityAt: response.streaming.last_activity_at,
                cachedContentLength: response.streaming.cached_content?.length || 0,
              })
            } else {
              console.info('[StreamingJoinDebug] task:join ack (no streaming)', {
                taskId,
                forceRefresh,
                afterMessageId,
                subtasksCount,
                firstMessageId: firstSubtask?.message_id,
                lastMessageId: lastSubtask?.message_id,
                hasError: Boolean(response.error),
              })
            }

            if (response.status_updated) {
              cacheChatStatusSnapshot(latestChatStatusRef, response.status_updated)
            }

            // If there was an error, remove from the set so it can be retried
            if (response.error) {
              joinedTasksRef.current.delete(taskId)
            }
            resolve(response)
          }
        )
      })
    },
    [socketClient]
  )

  /**
   * Leave a task room
   */
  const leaveTask = useCallback(
    (taskId: number) => {
      const currentSocket = socketClient.socket
      if (currentSocket.connected) {
        currentSocket.emit('task:leave', { task_id: taskId })
        joinedTasksRef.current.delete(taskId)
      }
    },
    [socketClient]
  )

  /**
   * Send a chat message via WebSocket
   */
  const sendChatMessage = useCallback(
    async (payload: ChatSendPayload): Promise<ChatSendAck> => {
      const currentSocket = socketClient.socket

      if (!currentSocket.connected) {
        console.error('[Socket.IO] sendChatMessage failed: not connected', {
          isConnected: currentSocket.connected,
        })
        return { error: 'Not connected to server' }
      }

      return new Promise(resolve => {
        currentSocket.emit(ClientEvents.CHAT_SEND, payload, (response: ChatSendAck) => {
          resolve(response)
        })
      })
    },
    [socketClient]
  )

  /**
   * Send Chat Shell guidance via WebSocket
   */
  const sendChatGuidance = useCallback(
    async (payload: ChatGuidePayload): Promise<ChatGuideAck> => {
      const currentSocket = socketClient.socket

      if (!currentSocket.connected) {
        console.error('[Socket.IO] sendChatGuidance failed: not connected', {
          isConnected: currentSocket.connected,
        })
        return { success: false, error: 'Not connected to server' }
      }

      return new Promise(resolve => {
        currentSocket.emit(ClientEvents.CHAT_GUIDE, payload, (response: ChatGuideAck) => {
          resolve(response)
        })
      })
    },
    [socketClient]
  )

  /**
   * Cancel a chat stream via WebSocket
   */
  const cancelChatStream = useCallback(
    async (
      subtaskId: number,
      partialContent?: string,
      shellType?: string
    ): Promise<{ success: boolean; error?: string }> => {
      const currentSocket = socketClient.socket
      if (!currentSocket.connected) {
        console.error('[Socket.IO] cancelChatStream failed - not connected')
        return { success: false, error: 'Not connected to server' }
      }

      currentSocket.emit('chat:cancel', {
        subtask_id: subtaskId,
        partial_content: partialContent,
        shell_type: shellType,
      })
      return { success: true }
    },
    [socketClient]
  )

  /**
   * Close a device task session via WebSocket
   */
  const closeTaskSession = useCallback(
    async (taskId: number): Promise<{ success: boolean; error?: string }> => {
      const currentSocket = socketClient.socket
      if (!currentSocket.connected) {
        console.error('[Socket.IO] closeTaskSession failed - not connected')
        return { success: false, error: 'Not connected to server' }
      }

      return new Promise(resolve => {
        currentSocket.emit(
          'task:close-session',
          { task_id: taskId },
          (response: { success?: boolean; error?: string }) => {
            resolve({ success: response.success ?? true, error: response.error })
          }
        )
      })
    },
    [socketClient]
  )

  /**
   * Retry a failed message via WebSocket
   */
  const retryMessage = useCallback(
    async (
      taskId: number,
      subtaskId: number,
      modelId?: string,
      modelType?: string,
      forceOverride: boolean = false
    ): Promise<{ success: boolean; error?: string }> => {
      const currentSocket = socketClient.socket
      if (!currentSocket.connected) {
        console.error('[Socket.IO] retryMessage failed - not connected')
        return { success: false, error: 'Not connected to server' }
      }

      const payload = {
        task_id: taskId,
        subtask_id: subtaskId,
        force_override_bot_model: modelId,
        force_override_bot_model_type: modelType,
        use_model_override: forceOverride,
      }

      return new Promise(resolve => {
        currentSocket.emit(
          'chat:retry',
          payload,
          (response: { success?: boolean; error?: string } | undefined) => {
            // Handle undefined response (backend error or no acknowledgment)
            if (!response) {
              console.error('[Socket.IO] chat:retry received undefined response')
              resolve({
                success: false,
                error: 'No response from server',
              })
              return
            }

            resolve({
              success: response.success ?? false,
              error: response.error,
            })
          }
        )
      })
    },
    [socketClient]
  )

  /**
   * Register chat event handlers
   * Returns a cleanup function to unregister handlers
   */
  const registerChatHandlers = useCallback(
    (handlers: ChatEventHandlers): (() => void) => {
      const wrappedStatusUpdated = handlers.onChatStatusUpdated
        ? (payload: ChatStatusUpdatedPayload) => {
            cacheChatStatusSnapshot(latestChatStatusRef, payload)
            handlers.onChatStatusUpdated?.(payload)
          }
        : undefined

      const cleanup = registerSocketHandlers(socketClient.socket, [
        socketHandler(ServerEvents.CHAT_START, handlers.onChatStart),
        socketHandler(ServerEvents.CHAT_CHUNK, handlers.onChatChunk),
        socketHandler(ServerEvents.CHAT_DONE, handlers.onChatDone),
        socketHandler(ServerEvents.CHAT_ERROR, handlers.onChatError),
        socketHandler(ServerEvents.CHAT_CANCELLED, handlers.onChatCancelled),
        socketHandler(ServerEvents.CHAT_STATUS_UPDATED, wrappedStatusUpdated),
        socketHandler(ServerEvents.CHAT_MESSAGE, handlers.onChatMessage),
        socketHandler(ServerEvents.CHAT_BLOCK_CREATED, handlers.onBlockCreated),
        socketHandler(ServerEvents.CHAT_BLOCK_UPDATED, handlers.onBlockUpdated),
        socketHandler(ServerEvents.CHAT_GUIDANCE_QUEUED, handlers.onGuidanceQueued),
        socketHandler(ServerEvents.CHAT_GUIDANCE_APPLIED, handlers.onGuidanceApplied),
        socketHandler(ServerEvents.CHAT_GUIDANCE_EXPIRED, handlers.onGuidanceExpired),
      ])

      if (wrappedStatusUpdated) {
        Object.values(latestChatStatusRef.current).forEach(snapshot => {
          wrappedStatusUpdated(snapshot)
        })
      }

      return cleanup
    },
    [socketClient]
  )

  /**
   * Register task event handlers for task list updates
   * Returns a cleanup function to unregister handlers
   */
  const registerTaskHandlers = useCallback(
    (handlers: TaskEventHandlers): (() => void) => {
      return registerSocketHandlers(socketClient.socket, [
        socketHandler(ServerEvents.TASK_CREATED, handlers.onTaskCreated),
        socketHandler(ServerEvents.TASK_INVITED, handlers.onTaskInvited),
        socketHandler(ServerEvents.TASK_STATUS, handlers.onTaskStatus),
        socketHandler(ServerEvents.TASK_APP_UPDATE, handlers.onTaskAppUpdate),
      ])
    },
    [socketClient]
  )

  /**
   * Register correction event handlers for cross-validation progress
   * Returns a cleanup function to unregister handlers
   */
  const registerCorrectionHandlers = useCallback(
    (handlers: CorrectionEventHandlers): (() => void) => {
      return registerSocketHandlers(socketClient.socket, [
        socketHandler(ServerEvents.CORRECTION_START, handlers.onCorrectionStart),
        socketHandler(ServerEvents.CORRECTION_PROGRESS, handlers.onCorrectionProgress),
        socketHandler(ServerEvents.CORRECTION_CHUNK, handlers.onCorrectionChunk),
        socketHandler(ServerEvents.CORRECTION_DONE, handlers.onCorrectionDone),
        socketHandler(ServerEvents.CORRECTION_ERROR, handlers.onCorrectionError),
      ])
    },
    [socketClient]
  )

  /**
   * Register skill event handlers for generic skill requests
   * Returns a cleanup function to unregister handlers
   */
  const registerSkillHandlers = useCallback(
    (handlers: SkillEventHandlers): (() => void) => {
      return registerSocketHandlers(socketClient.socket, [
        socketHandler(ServerEvents.SKILL_REQUEST, handlers.onSkillRequest),
      ])
    },
    [socketClient]
  )

  /**
   * Send skill response back to server
   */
  const sendSkillResponse = useCallback(
    (payload: SkillResponsePayload): void => {
      const currentSocket = socketClient.socket

      if (!currentSocket.connected) {
        console.error('[Socket.IO] sendSkillResponse failed: not connected')
        return
      }

      currentSocket.emit(ClientSkillEvents.SKILL_RESPONSE, payload)
    },
    [socketClient]
  )
  /**
   * Register background execution event handlers for subscription execution updates
   * Returns a cleanup function to unregister handlers
   */
  const registerBackgroundExecutionHandlers = useCallback(
    (handlers: BackgroundExecutionEventHandlers): (() => void) => {
      return registerSocketHandlers(socketClient.socket, [
        socketHandler(
          ServerEvents.BACKGROUND_EXECUTION_UPDATE,
          handlers.onBackgroundExecutionUpdate
        ),
      ])
    },
    [socketClient]
  )

  /**
   * Register a callback to be called when WebSocket reconnects
   * This is the single source of truth for reconnection events in the app.
   * Returns a cleanup function to unregister the callback.
   */
  const onReconnect = useCallback(
    (callback: ReconnectCallback): (() => void) => socketClient.onReconnect(callback),
    [socketClient]
  )

  // Auto-connect when component mounts if token is available
  useEffect(() => {
    // Only run on client side
    if (typeof window === 'undefined') {
      return
    }

    if (socketClient.socket.connected) {
      return
    }

    const token = getToken()
    if (token) {
      connect(token)
    } else {
      console.error('[Socket.IO] No token found, skipping auto-connect')
    }
  }, [connect, socketClient])

  // Listen for token changes (login/logout) - works across tabs
  // Also poll for token changes in current tab since storage event doesn't fire for same-tab changes
  useEffect(() => {
    // Handle cross-tab storage changes
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'auth_token') {
        if (e.newValue) {
          // Token was set (login from another tab)
          connect(e.newValue)
        } else {
          // Token was removed (logout from another tab)
          disconnect()
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => {
      window.removeEventListener('storage', handleStorageChange)
    }
  }, [connect, disconnect])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      socketClient.dispose()
    }
  }, [socketClient])

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        connectionError,
        reconnectAttempts,
        connect,
        disconnect,
        ensureConnected,
        joinTask,
        leaveTask,
        sendChatMessage,
        sendChatGuidance,
        cancelChatStream,
        closeTaskSession,
        retryMessage,
        registerChatHandlers,
        registerTaskHandlers,
        registerSkillHandlers,
        sendSkillResponse,
        registerCorrectionHandlers,
        registerBackgroundExecutionHandlers,
        onReconnect,
      }}
    >
      {children}
    </SocketContext.Provider>
  )
}

/**
 * Hook to use socket context
 */
export function useSocket(): SocketContextType {
  const context = useContext(SocketContext)
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider')
  }
  return context
}

/**
 * Hook to auto-connect socket when token is available
 * @deprecated Socket now auto-connects in SocketProvider
 */
export function useSocketAutoConnect(token: string | null) {
  const { connect, disconnect: _disconnect, isConnected } = useSocket()

  useEffect(() => {
    if (token && !isConnected) {
      connect(token)
    }
    return () => {
      // Don't disconnect on cleanup - let the provider manage lifecycle
    }
  }, [token, connect, isConnected])
}
