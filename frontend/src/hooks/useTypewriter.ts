// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Hook to provide a smooth typewriter effect for streaming content.
 *
 * It takes a rapidly updating string (targetContent) and returns a
 * smoothly updating string (displayedContent) that "types" out characters.
 *
 * @param content The full content string that updates over time
 * @param speed Base speed in milliseconds per tick (default: 30ms)
 * @returns The content to display
 */
export function useTypewriter(content: string, speed = 30) {
  const [displayedContent, setDisplayedContent] = useState('')
  const contentRef = useRef(content)
  const rafIdRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(0)
  const isRunningRef = useRef(false)

  // Update ref when content changes
  useEffect(() => {
    contentRef.current = content
    // Handle reset immediately
    if (content.length === 0 && displayedContent.length > 0) {
      setDisplayedContent('')
    }
  }, [content, displayedContent.length])

  // Animation frame callback
  const animate = useCallback(
    (timestamp: number) => {
      // Throttle updates based on speed
      if (timestamp - lastTimeRef.current < speed) {
        rafIdRef.current = requestAnimationFrame(animate)
        return
      }
      lastTimeRef.current = timestamp

      setDisplayedContent(current => {
        const target = contentRef.current

        // If caught up or ahead, stop animation
        if (current.length >= target.length) {
          isRunningRef.current = false
          return current.length > target.length ? target : current
        }

        const lag = target.length - current.length

        // Adaptive speed logic:
        // - Small lag (< 5 chars): Type 1 char at a time (smooth typing feel)
        // - Medium lag (5-20 chars): Speed up slightly
        // - Large lag (> 20 chars): Catch up quickly (bulk render)
        let step = 1
        if (lag > 50) {
          step = Math.ceil(lag / 5) // Very fast catchup
        } else if (lag > 20) {
          step = Math.ceil(lag / 10) + 1 // Fast catchup
        } else if (lag > 5) {
          step = 2 // Mild acceleration
        }

        // Ensure we don't overshoot
        const nextLength = Math.min(current.length + step, target.length)
        return target.slice(0, nextLength)
      })

      // Continue animation if still running
      if (isRunningRef.current) {
        rafIdRef.current = requestAnimationFrame(animate)
      }
    },
    [speed]
  )

  // Start animation when content changes and we're behind
  useEffect(() => {
    const shouldAnimate = content.length > displayedContent.length

    if (shouldAnimate && !isRunningRef.current) {
      isRunningRef.current = true
      rafIdRef.current = requestAnimationFrame(animate)
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [content, displayedContent.length, animate])

  return displayedContent
}
