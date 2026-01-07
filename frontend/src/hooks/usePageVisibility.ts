// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * usePageVisibility Hook
 *
 * This hook provides page visibility state and events using the Page Visibility API.
 * It's useful for:
 * - Pausing animations or video playback when page is hidden
 * - Recovering state when user returns to the page
 * - Syncing data when page becomes visible after being in background
 *
 * @example
 * ```tsx
 * const { isVisible, wasHidden } = usePageVisibility({
 *   onVisible: () => {
 *     // Sync data when page becomes visible
 *     refreshData();
 *   },
 *   onHidden: () => {
 *     // Pause operations when page is hidden
 *   },
 * });
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react'

export interface UsePageVisibilityOptions {
  /**
   * Callback when page becomes visible.
   * Includes `wasHiddenFor` - duration in milliseconds the page was hidden.
   */
  onVisible?: (wasHiddenFor: number) => void

  /**
   * Callback when page becomes hidden.
   */
  onHidden?: () => void

  /**
   * Minimum time (ms) the page must be hidden before triggering recovery on visible.
   * This prevents unnecessary recovery for quick tab switches.
   * Default: 5000 (5 seconds)
   */
  minHiddenTime?: number
}

export interface UsePageVisibilityResult {
  /** Whether the page is currently visible */
  isVisible: boolean

  /**
   * Whether the page was hidden since component mounted.
   * Useful to know if recovery might be needed.
   */
  wasHidden: boolean

  /**
   * Timestamp when the page was last hidden.
   * Null if page has never been hidden.
   */
  hiddenAt: number | null

  /**
   * Duration in ms the page was last hidden for.
   * Null if page has never been hidden and then shown again.
   */
  lastHiddenDuration: number | null
}

/**
 * Hook to track page visibility state and trigger callbacks on visibility changes.
 *
 * Uses the Page Visibility API (document.visibilityState) which is well-supported
 * in modern browsers and correctly handles:
 * - Tab switching
 * - Window minimization
 * - Mobile app switching to background
 * - Screen lock
 */
export function usePageVisibility(options: UsePageVisibilityOptions = {}): UsePageVisibilityResult {
  const { onVisible, onHidden, minHiddenTime = 5000 } = options

  const [isVisible, setIsVisible] = useState<boolean>(() => {
    // SSR safety: default to visible
    if (typeof document === 'undefined') return true
    return document.visibilityState === 'visible'
  })

  const [wasHidden, setWasHidden] = useState<boolean>(false)
  const [hiddenAt, setHiddenAt] = useState<number | null>(null)
  const [lastHiddenDuration, setLastHiddenDuration] = useState<number | null>(null)

  // Use refs for callbacks to avoid re-registering event listener
  const onVisibleRef = useRef(onVisible)
  const onHiddenRef = useRef(onHidden)

  // Update refs when callbacks change
  useEffect(() => {
    onVisibleRef.current = onVisible
  }, [onVisible])

  useEffect(() => {
    onHiddenRef.current = onHidden
  }, [onHidden])

  // Track when page was hidden
  const hiddenAtRef = useRef<number | null>(null)

  const handleVisibilityChange = useCallback(() => {
    const visible = document.visibilityState === 'visible'
    setIsVisible(visible)

    if (visible) {
      // Page became visible
      const hiddenTime = hiddenAtRef.current
      const now = Date.now()
      const wasHiddenFor = hiddenTime ? now - hiddenTime : 0

      setLastHiddenDuration(wasHiddenFor)

      // Only trigger recovery callback if hidden for longer than minHiddenTime
      if (hiddenTime && wasHiddenFor >= minHiddenTime) {
        onVisibleRef.current?.(wasHiddenFor)
      }

      hiddenAtRef.current = null
    } else {
      // Page became hidden
      const now = Date.now()
      hiddenAtRef.current = now
      setHiddenAt(now)
      setWasHidden(true)

      onHiddenRef.current?.()
    }
  }, [minHiddenTime])

  useEffect(() => {
    // SSR safety
    if (typeof document === 'undefined') return

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [handleVisibilityChange])

  return {
    isVisible,
    wasHidden,
    hiddenAt,
    lastHiddenDuration,
  }
}

export default usePageVisibility
