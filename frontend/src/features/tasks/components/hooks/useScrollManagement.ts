// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef, useCallback, useEffect } from 'react'

/**
 * Threshold in pixels for determining if user is near the bottom of the scroll container.
 * When the distance from bottom is less than this value, auto-scroll will be triggered.
 */
const AUTO_SCROLL_THRESHOLD = 32

export interface UseScrollManagementOptions {
  /**
   * Whether there are messages to display.
   * Used to determine when to attach scroll listeners.
   */
  hasMessages: boolean

  /**
   * Whether the stream is currently active.
   * When streaming, auto-scroll is more aggressive.
   */
  isStreaming: boolean

  /**
   * The ID of the currently selected task.
   * Used to trigger scroll to bottom when task changes.
   */
  selectedTaskId?: number | null

  /**
   * The ID of the last subtask in the list.
   * Used to trigger scroll when new subtasks are appended.
   */
  lastSubtaskId?: number | null

  /**
   * The updated_at timestamp of the last subtask.
   * Used to detect subtask updates.
   */
  lastSubtaskUpdatedAt?: string | null
}

export interface UseScrollManagementReturn {
  /**
   * Ref to attach to the scroll container element.
   */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>

  /**
   * Ref tracking whether user is near the bottom.
   * Can be used by other components to check scroll position.
   */
  isUserNearBottomRef: React.RefObject<boolean>

  /**
   * Function to scroll to the bottom of the container.
   * @param force - If true, scrolls regardless of user position.
   */
  scrollToBottom: (force?: boolean) => void

  /**
   * Callback to be called when messages content changes.
   * Triggers auto-scroll if appropriate.
   */
  handleMessagesContentChange: () => void
}

/**
 * useScrollManagement Hook
 *
 * Consolidates all scroll-related logic for the ChatArea component:
 * - Tracking user scroll position (near bottom detection)
 * - Auto-scrolling when new content arrives
 * - Scrolling to bottom on task change
 * - Scrolling when new subtasks are appended
 *
 * This hook extracts multiple useEffect calls from ChatArea into a single,
 * cohesive unit that manages scroll behavior.
 */
export function useScrollManagement({
  hasMessages,
  isStreaming,
  selectedTaskId,
  lastSubtaskId,
  lastSubtaskUpdatedAt,
}: UseScrollManagementOptions): UseScrollManagementReturn {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isUserNearBottomRef = useRef<boolean>(true)

  /**
   * Scrolls the container to the bottom.
   * Uses requestAnimationFrame for smooth scrolling.
   *
   * @param force - If true, scrolls regardless of user's current position.
   *                If false, only scrolls if user is already near bottom.
   */
  const scrollToBottom = useCallback((force = false) => {
    const container = scrollContainerRef.current
    if (!container) return

    if (force || isUserNearBottomRef.current) {
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight
          if (force) {
            isUserNearBottomRef.current = true
          }
        }
      })
    }
  }, [])

  /**
   * Callback for when message content changes.
   * Triggers auto-scroll if streaming or user is near bottom.
   */
  const handleMessagesContentChange = useCallback(() => {
    if (isStreaming || isUserNearBottomRef.current) {
      scrollToBottom()
    }
  }, [isStreaming, scrollToBottom])

  /**
   * Effect: Attach scroll event listener to track user position.
   *
   * This replaces the original useEffect at lines 400-414 in ChatArea.tsx.
   * Updates isUserNearBottomRef based on scroll position.
   */
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      isUserNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD
    }

    container.addEventListener('scroll', handleScroll)
    // Initialize the ref value
    handleScroll()

    return () => container.removeEventListener('scroll', handleScroll)
  }, [hasMessages])

  /**
   * Effect: Scroll to bottom when task changes.
   *
   * This replaces the original useEffect at lines 417-421 in ChatArea.tsx.
   * Forces scroll to bottom with a small delay to ensure content is rendered.
   */
  useEffect(() => {
    if (hasMessages && selectedTaskId) {
      const timer = setTimeout(() => scrollToBottom(true), 100)
      return () => clearTimeout(timer)
    }
  }, [selectedTaskId, hasMessages, scrollToBottom])

  /**
   * Effect: Auto-scroll when new subtasks are appended.
   *
   * This replaces the original useEffect at lines 429-437 in ChatArea.tsx.
   * Triggers scroll with a small delay when lastSubtaskId or its update time changes.
   */
  useEffect(() => {
    if (!hasMessages || !lastSubtaskId) return

    const timer = setTimeout(() => {
      scrollToBottom()
    }, 60)

    return () => clearTimeout(timer)
  }, [hasMessages, lastSubtaskId, lastSubtaskUpdatedAt, scrollToBottom])

  return {
    scrollContainerRef,
    isUserNearBottomRef,
    scrollToBottom,
    handleMessagesContentChange,
  }
}

export default useScrollManagement
