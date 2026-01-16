// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { computeAddedDiff, hasChanges, type DiffSegment } from '../utils/diff'

// Animation duration in milliseconds (matches CSS animation)
const ANIMATION_DURATION = 1800

interface UseContentDiffOptions {
  /** Animation duration in ms, defaults to 1800 */
  animationDuration?: number
  /** Callback when animation completes */
  onAnimationComplete?: () => void
}

interface ContentDiffState {
  /** Whether animation is currently playing */
  isAnimating: boolean
  /** Diff segments for rendering */
  segments: DiffSegment[]
  /** The current content being displayed */
  currentContent: string
}

interface UseContentDiffReturn extends ContentDiffState {
  /** Update content and trigger diff animation if there are changes */
  updateContent: (newContent: string) => void
  /** Force reset without animation */
  resetContent: (content: string) => void
  /** Check if content would have changes */
  wouldHaveChanges: (newContent: string) => boolean
}

/**
 * Hook to manage content diff state and animations
 *
 * Tracks content changes and provides diff segments for highlighting.
 * When content updates, computes diff and triggers animation.
 */
export function useContentDiff(
  initialContent: string = '',
  options: UseContentDiffOptions = {}
): UseContentDiffReturn {
  const { animationDuration = ANIMATION_DURATION, onAnimationComplete } = options

  // Track previous content for diff comparison
  const previousContentRef = useRef<string>(initialContent)

  // Current state
  const [state, setState] = useState<ContentDiffState>({
    isAnimating: false,
    segments: initialContent ? [{ type: 'unchanged', text: initialContent }] : [],
    currentContent: initialContent,
  })

  // Animation timer ref
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup animation timer on unmount
  useEffect(() => {
    return () => {
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current)
      }
    }
  }, [])

  // Update content and trigger diff animation
  const updateContent = useCallback(
    (newContent: string) => {
      const oldContent = previousContentRef.current

      // If no changes, just update content without animation
      if (!hasChanges(oldContent, newContent)) {
        setState(prev => ({
          ...prev,
          currentContent: newContent,
          segments: [{ type: 'unchanged', text: newContent }],
        }))
        return
      }

      // Compute diff segments (only showing unchanged + added)
      const segments = computeAddedDiff(oldContent, newContent)

      // Clear any existing animation timer
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current)
      }

      // Start animation
      setState({
        isAnimating: true,
        segments,
        currentContent: newContent,
      })

      // Update previous content reference
      previousContentRef.current = newContent

      // End animation after duration
      animationTimerRef.current = setTimeout(() => {
        setState(prev => ({
          ...prev,
          isAnimating: false,
          // After animation, show all as unchanged
          segments: [{ type: 'unchanged', text: prev.currentContent }],
        }))
        onAnimationComplete?.()
      }, animationDuration)
    },
    [animationDuration, onAnimationComplete]
  )

  // Force reset without animation
  const resetContent = useCallback((content: string) => {
    // Clear any existing animation
    if (animationTimerRef.current) {
      clearTimeout(animationTimerRef.current)
      animationTimerRef.current = null
    }

    previousContentRef.current = content
    setState({
      isAnimating: false,
      segments: content ? [{ type: 'unchanged', text: content }] : [],
      currentContent: content,
    })
  }, [])

  // Check if new content would have changes
  const wouldHaveChanges = useCallback(
    (newContent: string) => {
      return hasChanges(previousContentRef.current, newContent)
    },
    []
  )

  return {
    ...state,
    updateContent,
    resetContent,
    wouldHaveChanges,
  }
}
