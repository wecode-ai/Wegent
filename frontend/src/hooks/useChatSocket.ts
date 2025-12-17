// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * useChatSocket Hook
 *
 * Provides Socket.IO-based chat functionality for streaming chat messages.
 * Handles sending messages, receiving streaming responses, and cancellation.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSocket } from '@/contexts/SocketContext'
import {
  ServerEvents,
  ChatSendPayload,
  ChatSendAck,
  ChatStartPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatCancelledPayload,
  ChatMessagePayload,
} from '@/types/socket'

interface ChatSocketState {
  /** Whether streaming is in progress */
  isStreaming: boolean
  /** Whether stop operation is in progress */
  isStopping: boolean
  /** Accumulated streaming content */
  streamingContent: string
  /** Current offset in the stream */
  currentOffset: number
  /** Error if any */
  error: string | null
  /** Current task ID */
  taskId: number | null
  /** Current subtask ID */
  subtaskId: number | null
}

interface UseChatSocketOptions {
  /** Initial task ID (for existing tasks) */
  taskId?: number
  /** Callback when a new message is received from other users */
  onOtherUserMessage?: (message: ChatMessagePayload) => void
  /** Callback when streaming starts */
  onStreamStart?: (taskId: number, subtaskId: number) => void
  /** Callback when streaming completes */
  onStreamComplete?: (taskId: number, subtaskId: number, content: string) => void
  /** Callback when an error occurs */
  onError?: (error: string) => void
  /** Callback when streaming is cancelled */
  onCancelled?: (subtaskId: number) => void
}

interface UseChatSocketReturn extends ChatSocketState {
  /** Send a chat message */
  sendMessage: (payload: Omit<ChatSendPayload, 'task_id'>) => Promise<ChatSendAck>
  /** Cancel the current stream */
  cancelStream: () => Promise<void>
  /** Reset the chat state */
  resetState: () => void
  /** Set initial streaming state (for recovery) */
  setInitialStreaming: (content: string, offset: number, subtaskId: number) => void
}

const initialState: ChatSocketState = {
  isStreaming: false,
  isStopping: false,
  streamingContent: '',
  currentOffset: 0,
  error: null,
  taskId: null,
  subtaskId: null,
}

export function useChatSocket(options: UseChatSocketOptions = {}): UseChatSocketReturn {
  const { socket, isConnected, joinTask, leaveTask } = useSocket()
  const [state, setState] = useState<ChatSocketState>(() => ({
    ...initialState,
    taskId: options.taskId ?? null,
  }))

  // Refs for callbacks (to avoid stale closures)
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Ref for streaming content (more reliable for cancellation)
  const streamingContentRef = useRef('')

  /**
   * Handle chat:start event
   */
  const handleChatStart = useCallback((data: ChatStartPayload) => {
    if (state.taskId && data.task_id !== state.taskId) return

    setState((prev) => ({
      ...prev,
      isStreaming: true,
      taskId: data.task_id,
      subtaskId: data.subtask_id,
      streamingContent: '',
      currentOffset: 0,
      error: null,
    }))
    streamingContentRef.current = ''

    optionsRef.current.onStreamStart?.(data.task_id, data.subtask_id)
  }, [state.taskId])

  /**
   * Handle chat:chunk event
   */
  const handleChatChunk = useCallback((data: ChatChunkPayload) => {
    if (state.subtaskId && data.subtask_id !== state.subtaskId) return

    setState((prev) => {
      const newContent = prev.streamingContent + data.content
      streamingContentRef.current = newContent
      return {
        ...prev,
        streamingContent: newContent,
        currentOffset: data.offset + data.content.length,
      }
    })
  }, [state.subtaskId])

  /**
   * Handle chat:done event
   */
  const handleChatDone = useCallback((data: ChatDonePayload) => {
    if (state.subtaskId && data.subtask_id !== state.subtaskId) return

    const finalContent = data.result?.value as string || streamingContentRef.current

    setState((prev) => ({
      ...prev,
      isStreaming: false,
      isStopping: false,
      streamingContent: finalContent,
      currentOffset: data.offset,
    }))

    if (state.taskId && state.subtaskId) {
      optionsRef.current.onStreamComplete?.(state.taskId, state.subtaskId, finalContent)
    }
  }, [state.subtaskId, state.taskId])

  /**
   * Handle chat:error event
   */
  const handleChatError = useCallback((data: ChatErrorPayload) => {
    if (state.subtaskId && data.subtask_id !== state.subtaskId) return

    setState((prev) => ({
      ...prev,
      isStreaming: false,
      isStopping: false,
      error: data.error,
    }))

    optionsRef.current.onError?.(data.error)
  }, [state.subtaskId])

  /**
   * Handle chat:cancelled event
   */
  const handleChatCancelled = useCallback((data: ChatCancelledPayload) => {
    if (state.subtaskId && data.subtask_id !== state.subtaskId) return

    setState((prev) => ({
      ...prev,
      isStreaming: false,
      isStopping: false,
    }))

    optionsRef.current.onCancelled?.(data.subtask_id)
  }, [state.subtaskId])

  /**
   * Handle chat:message event (messages from other users)
   */
  const handleChatMessage = useCallback((data: ChatMessagePayload) => {
    if (state.taskId && data.task_id !== state.taskId) return

    optionsRef.current.onOtherUserMessage?.(data)
  }, [state.taskId])

  // Set up event listeners
  useEffect(() => {
    if (!socket) return

    socket.on(ServerEvents.CHAT_START, handleChatStart)
    socket.on(ServerEvents.CHAT_CHUNK, handleChatChunk)
    socket.on(ServerEvents.CHAT_DONE, handleChatDone)
    socket.on(ServerEvents.CHAT_ERROR, handleChatError)
    socket.on(ServerEvents.CHAT_CANCELLED, handleChatCancelled)
    socket.on(ServerEvents.CHAT_MESSAGE, handleChatMessage)

    return () => {
      socket.off(ServerEvents.CHAT_START, handleChatStart)
      socket.off(ServerEvents.CHAT_CHUNK, handleChatChunk)
      socket.off(ServerEvents.CHAT_DONE, handleChatDone)
      socket.off(ServerEvents.CHAT_ERROR, handleChatError)
      socket.off(ServerEvents.CHAT_CANCELLED, handleChatCancelled)
      socket.off(ServerEvents.CHAT_MESSAGE, handleChatMessage)
    }
  }, [
    socket,
    handleChatStart,
    handleChatChunk,
    handleChatDone,
    handleChatError,
    handleChatCancelled,
    handleChatMessage,
  ])

  // Join/leave task room when taskId changes
  useEffect(() => {
    if (!isConnected || !options.taskId) return

    joinTask(options.taskId).then((response) => {
      if (response.streaming) {
        // There's an active stream, restore it
        setState((prev) => ({
          ...prev,
          isStreaming: true,
          subtaskId: response.streaming!.subtask_id,
          streamingContent: response.streaming!.cached_content,
          currentOffset: response.streaming!.offset,
        }))
        streamingContentRef.current = response.streaming.cached_content
      }
    })

    return () => {
      if (options.taskId) {
        leaveTask(options.taskId)
      }
    }
  }, [isConnected, options.taskId, joinTask, leaveTask])

  /**
   * Send a chat message
   */
  const sendMessage = useCallback(
    async (payload: Omit<ChatSendPayload, 'task_id'>): Promise<ChatSendAck> => {
      if (!socket?.connected) {
        return { error: 'Not connected to server' }
      }

      return new Promise((resolve) => {
        const fullPayload: ChatSendPayload = {
          ...payload,
          task_id: state.taskId ?? undefined,
        }

        socket.emit('chat:send', fullPayload, (response: ChatSendAck) => {
          if (!response.error && response.task_id) {
            setState((prev) => ({
              ...prev,
              taskId: response.task_id!,
              subtaskId: response.subtask_id ?? null,
              isStreaming: true,
              streamingContent: '',
              currentOffset: 0,
              error: null,
            }))
            streamingContentRef.current = ''

            // Join the new task room if this is a new task
            if (!state.taskId && response.task_id) {
              joinTask(response.task_id)
            }
          }

          resolve(response)
        })
      })
    },
    [socket, state.taskId, joinTask]
  )

  /**
   * Cancel the current stream
   */
  const cancelStream = useCallback(async (): Promise<void> => {
    if (!socket?.connected || !state.subtaskId) return

    setState((prev) => ({ ...prev, isStopping: true }))

    return new Promise((resolve) => {
      socket.emit(
        'chat:cancel',
        {
          subtask_id: state.subtaskId,
          partial_content: streamingContentRef.current,
        },
        () => {
          setState((prev) => ({
            ...prev,
            isStreaming: false,
            isStopping: false,
          }))
          resolve()
        }
      )
    })
  }, [socket, state.subtaskId])

  /**
   * Reset the chat state
   */
  const resetState = useCallback(() => {
    setState({
      ...initialState,
      taskId: options.taskId ?? null,
    })
    streamingContentRef.current = ''
  }, [options.taskId])

  /**
   * Set initial streaming state (for recovery after page refresh)
   */
  const setInitialStreaming = useCallback(
    (content: string, offset: number, subtaskId: number) => {
      setState((prev) => ({
        ...prev,
        isStreaming: true,
        streamingContent: content,
        currentOffset: offset,
        subtaskId,
      }))
      streamingContentRef.current = content
    },
    []
  )

  return {
    ...state,
    sendMessage,
    cancelStream,
    resetState,
    setInitialStreaming,
  }
}
