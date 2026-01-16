// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Props for StreamingWaitIndicator component
 */
interface StreamingWaitIndicatorProps {
  /** Whether the indicator should be shown (waiting for first character) */
  isWaiting: boolean
  /** Optional start time for calculating wait duration (defaults to current time when isWaiting becomes true) */
  startTime?: number
}

/**
 * Wait stage configuration
 * Each stage has a duration threshold and translation key
 */
interface WaitStage {
  /** Minimum wait time in ms to show this stage */
  minTime: number
  /** Translation key for the message */
  messageKey: string
}

/**
 * Wait stages configuration:
 * - 0-500ms: No text, just dots
 * - 500ms-3s: "Thinking..."
 * - 3-6s: "Analyzing in depth..."
 * - 6-10s: "Please wait, generating response..."
 * - 10s+: "Response is taking longer than usual..."
 */
const WAIT_STAGES: WaitStage[] = [
  { minTime: 10000, messageKey: 'tasks:streaming_wait.longer_than_usual' },
  { minTime: 6000, messageKey: 'tasks:streaming_wait.generating_response' },
  { minTime: 3000, messageKey: 'tasks:streaming_wait.analyzing' },
  { minTime: 500, messageKey: 'tasks:streaming_wait.thinking' },
]

/**
 * StreamingWaitIndicator - Displays a typing indicator with progressive text
 * during the wait time before receiving the first character from the AI.
 *
 * Features:
 * - Three bouncing dots animation
 * - Progressive text that changes based on wait duration
 * - i18n support for Chinese and English
 * - Calm UI design with low saturation colors
 *
 * @example
 * ```tsx
 * <StreamingWaitIndicator isWaiting={isStreaming && !hasContent} />
 * ```
 */
export default function StreamingWaitIndicator({
  isWaiting,
  startTime: externalStartTime,
}: StreamingWaitIndicatorProps) {
  const { t } = useTranslation()
  const [internalStartTime, setInternalStartTime] = useState<number | null>(null)
  const [elapsedTime, setElapsedTime] = useState(0)

  // Track when waiting started
  useEffect(() => {
    if (isWaiting) {
      if (externalStartTime) {
        setInternalStartTime(externalStartTime)
      } else if (!internalStartTime) {
        setInternalStartTime(Date.now())
      }
    } else {
      setInternalStartTime(null)
      setElapsedTime(0)
    }
  }, [isWaiting, externalStartTime, internalStartTime])

  // Update elapsed time every 100ms for smooth stage transitions
  useEffect(() => {
    if (!isWaiting || !internalStartTime) return

    const intervalId = setInterval(() => {
      setElapsedTime(Date.now() - internalStartTime)
    }, 100)

    return () => clearInterval(intervalId)
  }, [isWaiting, internalStartTime])

  // Determine current stage message based on elapsed time
  const stageMessage = useMemo(() => {
    // Find the first stage whose minTime is <= elapsedTime (stages are sorted descending)
    const stage = WAIT_STAGES.find(s => elapsedTime >= s.minTime)
    return stage ? t(stage.messageKey) : null
  }, [elapsedTime, t])

  // Don't render if not waiting
  if (!isWaiting) return null

  return (
    <div className="flex items-center gap-1">
      {/* Progressive text message */}
      {stageMessage && <span className="text-sm text-text-muted">{stageMessage}</span>}

      {/* Typing indicator - three subtle pulsing dots */}
      <div className="flex items-center gap-1 h-4">
        <span
          className="w-1 h-1 rounded-full bg-text-muted/60 animate-pulse"
          style={{ animationDelay: '0ms', animationDuration: '1.5s' }}
        />
        <span
          className="w-1 h-1 rounded-full bg-text-muted/60 animate-pulse"
          style={{ animationDelay: '300ms', animationDuration: '1.5s' }}
        />
        <span
          className="w-1 h-1 rounded-full bg-text-muted/60 animate-pulse"
          style={{ animationDelay: '600ms', animationDuration: '1.5s' }}
        />
      </div>
    </div>
  )
}
