// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef } from 'react'

/**
 * Hook to provide a smooth typewriter effect for streaming content.
 *
 * It takes a rapidly updating string (targetContent) and returns a
 * smoothly updating string (displayedContent) that "types" out characters.
 *
 * @param content The full content string that updates over time
 * @param speed Base speed in milliseconds per tick (default: 15ms)
 * @returns The content to display
 */
export function useTypewriter(content: string, speed = 15) {
  const [displayedContent, setDisplayedContent] = useState('')
  const contentRef = useRef(content)

  // Update ref when content changes
  useEffect(() => {
    contentRef.current = content
    // Handle reset immediately
    if (content.length === 0 && displayedContent.length > 0) {
      setDisplayedContent('')
    }
  }, [content, displayedContent.length])

  useEffect(() => {
    const timer = setInterval(() => {
      setDisplayedContent(current => {
        const target = contentRef.current

        // If current is longer than target (e.g. content truncated/reset but not caught above),
        // or equal, just return target or current.
        if (current.length >= target.length) {
          return current.length > target.length ? target : current
        }

        const lag = target.length - current.length

        // Adaptive speed logic:
        // - Small lag (< 5 chars): Type 1 char at a time (smooth typing feel)
        // - Medium lag (5-20 chars): Speed up slightly
        // - Large lag (> 20 chars): Catch up quickly (bulk render)
        // This prevents the display from falling too far behind the stream.
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
    }, speed)

    return () => clearInterval(timer)
  }, [speed])

  return displayedContent
}
