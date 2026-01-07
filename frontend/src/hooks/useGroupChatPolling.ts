// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for polling new messages in group chat
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { pollNewMessages, SubtaskWithSender } from '@/apis/group-chat'

interface UseGroupChatPollingOptions {
  taskId: number
  isGroupChat: boolean
  enabled?: boolean
  pollingDelay?: number // delay after response before next poll, in milliseconds, default 5000
  pollingTimeout?: number // timeout for each poll request, in milliseconds, default 10000
  onNewMessages?: (messages: SubtaskWithSender[]) => void
  onStreamingDetected?: (subtaskId: number) => void
}

interface UseGroupChatPollingResult {
  newMessages: SubtaskWithSender[]
  isPolling: boolean
  hasStreaming: boolean
  streamingSubtaskId?: number
  error: Error | null
  clearMessages: () => void
}

/**
 * Hook for polling new messages in group chat
 *
 * Polls the backend with a delay after each response (default 5 seconds).
 * If a request times out (default 10 seconds), it will continue with the next poll.
 * Automatically tracks the last received subtask ID and only fetches incremental updates.
 *
 * @param options - Configuration options
 * @returns Polling state and control functions
 */
export function useGroupChatPolling(
  options: UseGroupChatPollingOptions
): UseGroupChatPollingResult {
  const {
    taskId,
    isGroupChat,
    enabled = true,
    pollingDelay = 5000,
    pollingTimeout = 10000,
    onNewMessages,
    onStreamingDetected,
  } = options

  const [newMessages, setNewMessages] = useState<SubtaskWithSender[]>([])
  const [isPolling, setIsPolling] = useState(false)
  const [hasStreaming, setHasStreaming] = useState(false)
  const [streamingSubtaskId, setStreamingSubtaskId] = useState<number>()
  const [error, setError] = useState<Error | null>(null)

  const lastSubtaskIdRef = useRef<number | undefined>(undefined)
  const pollingTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const pollFnRef = useRef<() => Promise<void> | undefined>(undefined)
  const isMountedRef = useRef(true)

  // Store callbacks in refs to avoid re-creating poll function on every render
  const onNewMessagesRef = useRef(onNewMessages)
  const onStreamingDetectedRef = useRef(onStreamingDetected)

  // Keep refs updated
  useEffect(() => {
    onNewMessagesRef.current = onNewMessages
  }, [onNewMessages])

  useEffect(() => {
    onStreamingDetectedRef.current = onStreamingDetected
  }, [onStreamingDetected])

  // Clear messages
  const clearMessages = useCallback(() => {
    setNewMessages([])
  }, [])

  // Schedule next poll after delay
  const scheduleNextPoll = useCallback(() => {
    if (!isMountedRef.current || !isGroupChat || !enabled) {
      return
    }

    pollingTimerRef.current = setTimeout(() => {
      pollFnRef.current?.()
    }, pollingDelay)
  }, [isGroupChat, enabled, pollingDelay])

  // Polling function with timeout
  const poll = useCallback(async () => {
    if (!isGroupChat || !enabled || !isMountedRef.current) {
      return
    }

    // Create abort controller for timeout
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => {
      abortController.abort()
    }, pollingTimeout)

    try {
      setIsPolling(true)
      setError(null)

      const response = await pollNewMessages(taskId, lastSubtaskIdRef.current)

      clearTimeout(timeoutId)

      if (!isMountedRef.current) return

      // Update last subtask ID
      if (response.messages.length > 0) {
        const latestMessage = response.messages[response.messages.length - 1]
        lastSubtaskIdRef.current = latestMessage.id

        // Add new messages
        setNewMessages(prev => [...prev, ...response.messages])

        // Notify callback using ref
        onNewMessagesRef.current?.(response.messages)
      }

      // Update streaming status
      setHasStreaming(response.has_streaming)
      setStreamingSubtaskId(response.streaming_subtask_id)

      // Notify streaming detected using ref
      if (response.has_streaming && response.streaming_subtask_id) {
        onStreamingDetectedRef.current?.(response.streaming_subtask_id)
      }
    } catch (err) {
      clearTimeout(timeoutId)

      if (!isMountedRef.current) return

      const error = err as Error
      // Only log non-abort errors
      if (error.name !== 'AbortError') {
        setError(error)
        console.error('[useGroupChatPolling] Polling error:', error)
      } else {
        console.warn('[useGroupChatPolling] Polling request timed out')
      }
    } finally {
      if (isMountedRef.current) {
        setIsPolling(false)
        // Schedule next poll after this one completes (or times out)
        scheduleNextPoll()
      }
    }
  }, [taskId, isGroupChat, enabled, pollingTimeout, scheduleNextPoll])

  // Keep pollFnRef updated with the latest poll function
  useEffect(() => {
    pollFnRef.current = poll
  }, [poll])

  // Track if initial poll has been done for current taskId
  const initialPollDoneRef = useRef(false)

  // Start polling - only depends on stable values, not poll function
  useEffect(() => {
    if (!isGroupChat || !enabled) {
      initialPollDoneRef.current = false
      return
    }

    // Reset for new taskId
    initialPollDoneRef.current = false
    lastSubtaskIdRef.current = undefined

    // Use setTimeout to ensure pollFnRef is set before calling
    const initialPollTimer = setTimeout(() => {
      if (!initialPollDoneRef.current && isMountedRef.current) {
        initialPollDoneRef.current = true
        pollFnRef.current?.()
      }
    }, 0)

    return () => {
      clearTimeout(initialPollTimer)
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current)
      }
    }
  }, [taskId, isGroupChat, enabled])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current)
      }
    }
  }, [])

  return {
    newMessages,
    isPolling,
    hasStreaming,
    streamingSubtaskId,
    error,
    clearMessages,
  }
}
