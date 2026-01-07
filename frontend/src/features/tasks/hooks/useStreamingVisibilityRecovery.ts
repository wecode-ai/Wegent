// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useStreamingVisibilityRecovery Hook
 *
 * This hook handles automatic recovery of streaming state when:
 * 1. The user returns to the page after being in the background (tab switch, app switch, screen lock, etc.)
 * 2. The WebSocket connection is restored after a network disconnection
 *
 * Problem it solves:
 * When streaming chat messages, if the user switches to another tab, puts the app
 * in the background, or loses network connection, WebSocket may miss some chunks.
 * When the user returns or network is restored, the message state might be stale
 * and not update correctly.
 *
 * Solution:
 * 1. Detect when page becomes visible after being hidden using Page Visibility API
 * 2. Detect when WebSocket reconnects after a disconnection
 * 3. If there was an active streaming task, rejoin the WebSocket room and sync state
 * 4. Optionally fetch the latest task detail from backend to ensure consistency
 *
 * @example
 * ```tsx
 * // In ChatArea or MessagesArea component
 * useStreamingVisibilityRecovery({
 *   taskId: selectedTaskDetail?.id,
 *   isStreaming: streamHandlers.isStreaming,
 *   onRecovery: () => refreshSelectedTaskDetail(),
 * });
 * ```
 */

import { useCallback, useEffect, useRef } from 'react'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useSocket } from '@/contexts/SocketContext'
import { useChatStreamContext } from '../contexts/chatStreamContext'
import { useTaskContext } from '../contexts/taskContext'

export interface UseStreamingVisibilityRecoveryOptions {
  /**
   * The current task ID. Recovery will be skipped if not provided.
   */
  taskId?: number | null

  /**
   * Whether streaming is currently active.
   * Used to determine if recovery is needed.
   */
  isStreaming?: boolean

  /**
   * Minimum time (ms) the page must be hidden before triggering recovery.
   * Default: 3000 (3 seconds)
   */
  minHiddenTime?: number

  /**
   * Whether recovery is enabled.
   * Default: true
   */
  enabled?: boolean

  /**
   * Callback after recovery completes.
   */
  onRecovery?: () => void

  /**
   * Callback when recovery starts.
   */
  onRecoveryStart?: () => void
}

export interface UseStreamingVisibilityRecoveryResult {
  /**
   * Whether the page is currently visible.
   */
  isVisible: boolean

  /**
   * Whether recovery is currently in progress.
   */
  isRecovering: boolean

  /**
   * Manually trigger recovery (useful for testing or manual refresh).
   */
  triggerRecovery: () => Promise<void>
}

/**
 * Hook to automatically recover streaming state when user returns to the page.
 *
 * This hook:
 * 1. Monitors page visibility using the Page Visibility API
 * 2. When page becomes visible after being hidden for minHiddenTime:
 *    - Rejoins the WebSocket task room to resync streaming state
 *    - Optionally refreshes task detail from backend
 * 3. Handles edge cases like no active task or streaming already completed
 */
export function useStreamingVisibilityRecovery(
  options: UseStreamingVisibilityRecoveryOptions = {}
): UseStreamingVisibilityRecoveryResult {
  const {
    taskId,
    isStreaming: wasStreamingBeforeHidden,
    minHiddenTime = 3000,
    enabled = true,
    onRecovery,
    onRecoveryStart,
  } = options

  const { joinTask, isConnected, reconnectAttempts } = useSocket()
  const { resumeStream, getStreamState } = useChatStreamContext()
  const { refreshSelectedTaskDetail } = useTaskContext()

  // Track if recovery is in progress
  const isRecoveringRef = useRef(false)

  // Track the streaming state before page was hidden or network disconnected
  const wasStreamingRef = useRef(wasStreamingBeforeHidden)

  // Track previous connection state to detect reconnection
  const wasConnectedRef = useRef(isConnected)
  // Track previous reconnect attempts to detect successful reconnection
  const prevReconnectAttemptsRef = useRef(reconnectAttempts)

  // Update the ref when streaming state changes (use effect to avoid render-phase mutation)
  useEffect(() => {
    if (wasStreamingBeforeHidden !== undefined) {
      wasStreamingRef.current = wasStreamingBeforeHidden
    }
  }, [wasStreamingBeforeHidden])

  /**
   * Perform recovery when page becomes visible
   */
  const performRecovery = useCallback(
    async (wasHiddenFor: number) => {
      // Skip if disabled or no task
      if (!enabled || !taskId) {
        return
      }

      // Skip if recovery already in progress
      if (isRecoveringRef.current) {
        return
      }

      // Check if we should attempt recovery
      // We recover if:
      // 1. Streaming was active before hiding, OR
      // 2. The current stream state shows streaming, OR
      // 3. We were hidden long enough that we might have missed updates
      const currentStreamState = getStreamState(taskId)
      const hasStreamingMessage = currentStreamState?.messages
        ? Array.from(currentStreamState.messages.values()).some(
            msg => msg.type === 'ai' && msg.status === 'streaming'
          )
        : false

      const shouldRecover = wasStreamingRef.current || hasStreamingMessage || wasHiddenFor > 10000

      if (!shouldRecover) {
        return
      }

      console.log('[StreamingVisibilityRecovery] Starting recovery...', {
        taskId,
        wasHiddenFor,
        wasStreaming: wasStreamingRef.current,
        hasStreamingMessage,
      })

      isRecoveringRef.current = true
      onRecoveryStart?.()

      try {
        // Step 1: Rejoin WebSocket room to resync streaming state
        // This is important because we might have missed chat:chunk or chat:done events
        if (isConnected && taskId) {
          const response = await joinTask(taskId)

          // If there's active streaming, resume it
          if (response.streaming) {
            console.log('[StreamingVisibilityRecovery] Found active streaming, resuming...', {
              subtaskId: response.streaming.subtask_id,
              cachedContentLength: response.streaming.cached_content?.length || 0,
            })

            await resumeStream(taskId)
          }
        }

        // Step 2: Refresh task detail from backend to ensure we have latest subtasks
        // This handles the case where streaming completed while we were in background
        // and we need to fetch the final result.
        // Note: We don't manually call syncBackendMessages here because useUnifiedMessages
        // hook will automatically sync when selectedTaskDetail updates.
        await refreshSelectedTaskDetail()

        console.log('[StreamingVisibilityRecovery] Recovery completed')
        onRecovery?.()
      } catch (error) {
        console.error('[StreamingVisibilityRecovery] Recovery failed:', error)
      } finally {
        isRecoveringRef.current = false
      }
    },
    [
      enabled,
      taskId,
      getStreamState,
      isConnected,
      joinTask,
      resumeStream,
      refreshSelectedTaskDetail,
      onRecoveryStart,
      onRecovery,
    ]
  )

  // Handle page hidden - track streaming state
  const handleHidden = useCallback(() => {
    // Record if streaming was active when page was hidden
    if (taskId) {
      const currentStreamState = getStreamState(taskId)
      const hasStreamingMessage = currentStreamState?.messages
        ? Array.from(currentStreamState.messages.values()).some(
            msg => msg.type === 'ai' && msg.status === 'streaming'
          )
        : false

      wasStreamingRef.current = hasStreamingMessage || wasStreamingBeforeHidden
      console.log('[StreamingVisibilityRecovery] Page hidden, streaming state:', {
        taskId,
        wasStreaming: wasStreamingRef.current,
      })
    }
  }, [taskId, getStreamState, wasStreamingBeforeHidden])

  // Use page visibility hook
  const { isVisible } = usePageVisibility({
    onVisible: performRecovery,
    onHidden: handleHidden,
    minHiddenTime,
  })

  /**
   * Handle WebSocket reconnection - trigger recovery when connection is restored
   *
   * This handles the case where:
   * 1. User is receiving streaming content
   * 2. Network disconnects (WebSocket disconnects)
   * 3. Network reconnects (WebSocket reconnects)
   * 4. We need to recover the missed streaming content
   *
   * Detection logic:
   * - When isConnected changes from false to true AND reconnectAttempts > 0,
   *   it means we just successfully reconnected after a disconnection
   */
  useEffect(() => {
    const wasDisconnected = !wasConnectedRef.current
    const isNowConnected = isConnected
    const hadReconnectAttempts = prevReconnectAttemptsRef.current > 0

    // Update refs for next comparison
    wasConnectedRef.current = isConnected
    prevReconnectAttemptsRef.current = reconnectAttempts

    // Detect successful reconnection: was disconnected, now connected, and had reconnect attempts
    // This means Socket.IO successfully reconnected after a network disconnection
    if (wasDisconnected && isNowConnected && hadReconnectAttempts) {
      console.log('[StreamingVisibilityRecovery] WebSocket reconnected, triggering recovery...', {
        taskId,
        reconnectAttempts,
      })

      // Trigger recovery with a reasonable "hidden time" to ensure recovery happens
      // Use minHiddenTime + 1 to ensure the shouldRecover check passes
      performRecovery(minHiddenTime + 1)
    }
  }, [isConnected, reconnectAttempts, taskId, minHiddenTime, performRecovery])

  // Manual recovery trigger
  const triggerRecovery = useCallback(async () => {
    await performRecovery(minHiddenTime + 1)
  }, [performRecovery, minHiddenTime])

  return {
    isVisible,
    isRecovering: isRecoveringRef.current,
    triggerRecovery,
  }
}

export default useStreamingVisibilityRecovery
