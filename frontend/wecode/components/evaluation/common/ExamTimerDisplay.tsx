// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useMemo } from 'react'
import { Clock } from 'lucide-react'
import {
  getTimerColorClass,
  formatTime,
  isTimerCritical,
  calculateDisplayTime,
  checkIsOvertime,
} from './exam-timer-utils'

interface ExamTimerDisplayProps {
  /** Initial remaining seconds from server (negative values indicate overtime) */
  initialRemainingSeconds: number
  /** Current exam phase - timer only shows during 'exam' phase */
  phase: 'intro' | 'exam' | 'review' | 'completed'
  /** Optional className for additional styling */
  className?: string
  /** Optional color class to override default color logic */
  colorClass?: string
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
}

/**
 * Reusable exam timer display component with real-time countdown.
 *
 * This component handles the visual display of exam timers with:
 * - Server-synchronized time (initial value from server)
 * - Local countdown for smooth display updates
 * - Color-coded states based on remaining time
 * - Overtime display with + prefix
 * - Pulsing animation when time is critical (< 5 minutes)
 *
 * The timer only displays during the 'exam' phase. For other phases,
 * it returns null (no rendering).
 */
export function ExamTimerDisplay({
  initialRemainingSeconds,
  phase,
  className = '',
  colorClass,
  size = 'md',
}: ExamTimerDisplayProps) {
  const [remainingSeconds, setRemainingSeconds] = useState(initialRemainingSeconds)

  // Sync with server-provided value when it changes
  useEffect(() => {
    setRemainingSeconds(initialRemainingSeconds)
  }, [initialRemainingSeconds])

  // Local countdown - only during exam phase
  useEffect(() => {
    if (phase !== 'exam') return

    const interval = setInterval(() => {
      setRemainingSeconds(prev => prev - 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [phase])

  // Only show timer during exam phase
  if (phase !== 'exam') {
    return null
  }

  const isOvertime = checkIsOvertime(remainingSeconds)
  const displayTime = calculateDisplayTime(remainingSeconds)
  const computedColorClass = getTimerColorClass(displayTime, isOvertime)
  const timerColor = colorClass || computedColorClass
  const isCritical = isTimerCritical(remainingSeconds, isOvertime)

  // Size variants
  const sizeClasses = {
    sm: 'px-2 py-1 text-xs gap-1',
    md: 'px-3 py-1.5 text-sm gap-1.5',
    lg: 'px-4 py-2 text-base gap-2',
  }

  const iconSizes = {
    sm: 12,
    md: 14,
    lg: 16,
  }

  return (
    <div
      className={`
        inline-flex items-center rounded-lg border font-mono font-semibold
        ${timerColor}
        ${sizeClasses[size]}
        ${isCritical ? 'animate-[timerPulse_1s_ease-in-out_infinite]' : ''}
        ${className}
      `}
      title={isOvertime ? 'Overtime' : 'Time remaining'}
    >
      <Clock size={iconSizes[size]} />
      <span>{formatTime(remainingSeconds, isOvertime)}</span>
    </div>
  )
}

/**
 * Hook for managing exam timer with server-synchronized time.
 *
 * Similar to useExamTimer but simplified for list view usage.
 */
export function useSessionTimer(
  initialRemainingSeconds: number,
  phase: 'intro' | 'exam' | 'review' | 'completed'
) {
  const [remainingSeconds, setRemainingSeconds] = useState(initialRemainingSeconds)

  // Sync with server-provided value when it changes
  useEffect(() => {
    setRemainingSeconds(initialRemainingSeconds)
  }, [initialRemainingSeconds])

  // Local countdown - only during exam phase
  useEffect(() => {
    if (phase !== 'exam') return

    const interval = setInterval(() => {
      setRemainingSeconds(prev => prev - 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [phase])

  const isOvertime = checkIsOvertime(remainingSeconds)
  const showTimer = phase === 'exam'

  const formattedTime = useMemo(
    () => formatTime(remainingSeconds, isOvertime),
    [remainingSeconds, isOvertime]
  )

  const timerColor = useMemo(() => {
    const displayTime = calculateDisplayTime(remainingSeconds)
    return getTimerColorClass(displayTime, isOvertime)
  }, [remainingSeconds, isOvertime])

  const isCritical = useMemo(
    () => isTimerCritical(remainingSeconds, isOvertime),
    [remainingSeconds, isOvertime]
  )

  return {
    remainingSeconds,
    isOvertime,
    showTimer,
    formattedTime,
    timerColor,
    isCritical,
  }
}
