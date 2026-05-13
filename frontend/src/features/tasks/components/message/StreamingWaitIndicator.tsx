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
  /** Whether the indicator should be shown */
  isWaiting: boolean
  /** Optional start time for calculating wait duration (defaults to current time when isWaiting becomes true) */
  startTime?: number
  /** Optional fixed message for non-progressive waiting states */
  message?: string
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

const RUNNER_ANIMATION_LAP_MS = 5400

/**
 * Wait stages configuration:
 * Text changes are aligned with complete runner animation laps.
 * - 0-5.4s: "Thinking..."
 * - 5.4-10.8s: "Analyzing in depth..."
 * - 10.8-16.2s: "Please wait, generating response..."
 * - 16.2s+: "Response is taking longer than usual..."
 */
const WAIT_STAGES: WaitStage[] = [
  { minTime: RUNNER_ANIMATION_LAP_MS * 3, messageKey: 'tasks:streaming_wait.longer_than_usual' },
  { minTime: RUNNER_ANIMATION_LAP_MS * 2, messageKey: 'tasks:streaming_wait.generating_response' },
  { minTime: RUNNER_ANIMATION_LAP_MS, messageKey: 'tasks:streaming_wait.analyzing' },
  { minTime: 0, messageKey: 'tasks:streaming_wait.thinking' },
]

/**
 * StreamingWaitIndicator - Displays a runner indicator with progressive or fixed text
 * while an AI message is waiting or still processing.
 *
 * Features:
 * - Single purple runner dot animation
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
  message,
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
    if (message) return message

    // Find the first stage whose minTime is <= elapsedTime (stages are sorted descending)
    const stage = WAIT_STAGES.find(s => elapsedTime >= s.minTime)
    return stage ? t(stage.messageKey) : null
  }, [elapsedTime, message, t])

  // Don't render if not waiting
  if (!isWaiting) return null

  return (
    <div
      className="inline-flex items-center"
      role="status"
      aria-live="polite"
      data-testid="streaming-wait-indicator"
    >
      <span className="streaming-wait-runner-track" data-testid="streaming-wait-runner-track">
        <span className="streaming-wait-runner-text-wrap">
          <span className="streaming-wait-runner-text">{stageMessage}</span>
          <span
            className="streaming-wait-runner-text-mask"
            aria-hidden="true"
            data-testid="streaming-wait-runner-text-mask"
          >
            {stageMessage}
          </span>
        </span>
        <span
          className="streaming-wait-runner-dot"
          aria-hidden="true"
          data-testid="streaming-wait-runner-dot"
        />
      </span>
    </div>
  )
}
