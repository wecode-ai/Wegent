// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from 'react'

/**
 * Feedback state type: null = no feedback, 'like' = liked, 'dislike' = disliked
 */
export type FeedbackState = 'like' | 'dislike' | null

/**
 * localStorage key prefix for message feedback
 */
const FEEDBACK_STORAGE_KEY_PREFIX = 'wegent_message_feedback_'

/**
 // Generate a unique storage key for a message
 // Priority: subtaskId > timestamp (as fallback)
 */
function generateStorageKey(
  subtaskId?: number,
  timestamp?: number,
  messageType?: 'original' | 'correction'
): string | null {
  const suffix = messageType === 'correction' ? '_correction' : ''

  if (subtaskId) {
    return `${FEEDBACK_STORAGE_KEY_PREFIX}subtask_${subtaskId}${suffix}`
  }
  if (timestamp) {
    return `${FEEDBACK_STORAGE_KEY_PREFIX}ts_${timestamp}${suffix}`
  }
  return null
}

/**
 * Read feedback from localStorage
 */
function readFeedbackFromStorage(key: string | null): FeedbackState {
  if (!key || typeof window === 'undefined') {
    return null
  }
  try {
    const stored = localStorage.getItem(key)
    if (stored === 'like' || stored === 'dislike') {
      return stored
    }
    return null
  } catch {
    // localStorage may be unavailable (e.g., private browsing mode)
    return null
  }
}

/**
 * Write feedback to localStorage
 */
function writeFeedbackToStorage(key: string | null, feedback: FeedbackState): void {
  if (!key || typeof window === 'undefined') {
    return
  }
  try {
    if (feedback === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, feedback)
    }
  } catch {
    // localStorage may be unavailable or full
    console.warn('Failed to save feedback to localStorage')
  }
}

/**
 * Hook options
 */
export interface UseMessageFeedbackOptions {
  /** Subtask ID - preferred identifier for the message */
  subtaskId?: number
  /** Message timestamp - fallback identifier if subtaskId is not available */
  timestamp?: number
  /** Message type to differentiate between original message and correction */
  messageType?: 'original' | 'correction'
  /** Callback when feedback changes */
  onFeedbackChange?: (feedback: FeedbackState) => void
}

/**
 * Hook return value
 */
export interface UseMessageFeedbackReturn {
  /** Current feedback state */
  feedback: FeedbackState
  /** Set feedback to 'like' (toggles if already liked) */
  handleLike: () => void
  /** Set feedback to 'dislike' (toggles if already disliked) */
  handleDislike: () => void
  /** Clear feedback */
  clearFeedback: () => void
}

/**
 * Custom hook for managing message feedback with localStorage persistence
 *
 * @example
 * ```tsx
 * const { feedback, handleLike, handleDislike } = useMessageFeedback({
 *   subtaskId: msg.subtaskId,
 *   timestamp: msg.timestamp,
 *   onFeedbackChange: (fb) => trace.event('message-feedback', { type: fb })
 * });
 * ```
 */
export function useMessageFeedback(options: UseMessageFeedbackOptions): UseMessageFeedbackReturn {
  const { subtaskId, timestamp, messageType, onFeedbackChange } = options

  // Generate storage key based on available identifiers
  const storageKey = generateStorageKey(subtaskId, timestamp, messageType)

  // Initialize state from localStorage
  const [feedback, setFeedback] = useState<FeedbackState>(() => {
    return readFeedbackFromStorage(storageKey)
  })

  // Update state when storage key changes (e.g., when subtaskId becomes available)
  useEffect(() => {
    const storedFeedback = readFeedbackFromStorage(storageKey)
    setFeedback(storedFeedback)
  }, [storageKey])

  // Handle feedback change with persistence
  const updateFeedback = useCallback(
    (newFeedback: FeedbackState) => {
      setFeedback(newFeedback)
      writeFeedbackToStorage(storageKey, newFeedback)
      onFeedbackChange?.(newFeedback)
    },
    [storageKey, onFeedbackChange]
  )

  // Toggle like
  const handleLike = useCallback(() => {
    const newFeedback = feedback === 'like' ? null : 'like'
    updateFeedback(newFeedback)
  }, [feedback, updateFeedback])

  // Toggle dislike
  const handleDislike = useCallback(() => {
    const newFeedback = feedback === 'dislike' ? null : 'dislike'
    updateFeedback(newFeedback)
  }, [feedback, updateFeedback])

  // Clear feedback
  const clearFeedback = useCallback(() => {
    updateFeedback(null)
  }, [updateFeedback])

  return {
    feedback,
    handleLike,
    handleDislike,
    clearFeedback,
  }
}

export default useMessageFeedback
