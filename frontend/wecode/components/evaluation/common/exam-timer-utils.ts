// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Utility functions for exam timer calculations.
 *
 * These functions are shared between ExamTimerDisplay component and
 * useSessionTimer hook to ensure consistent behavior.
 */

/**
 * Get timer color class based on remaining time
 */
export function getTimerColorClass(timeLeft: number, isOvertime: boolean): string {
  if (isOvertime) return 'text-red-600 bg-red-50 border-red-200'
  if (timeLeft > 15 * 60) return 'text-emerald-600 bg-emerald-50 border-emerald-200'
  if (timeLeft > 5 * 60) return 'text-yellow-600 bg-yellow-50 border-yellow-200'
  return 'text-red-600 bg-red-50 border-red-200'
}

/**
 * Format time display: MM:SS with optional + prefix for overtime
 */
export function formatTime(seconds: number, isOvertime: boolean): string {
  const absSeconds = Math.abs(seconds)
  const sign = isOvertime ? '+' : ''
  const minutes = Math.floor(absSeconds / 60)
  const secs = absSeconds % 60
  return `${sign}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/**
 * Check if timer is in critical state (less than 5 minutes remaining)
 */
export function isTimerCritical(timeLeft: number, isOvertime: boolean): boolean {
  const displayTime = isOvertime ? Math.abs(timeLeft) : Math.max(0, timeLeft)
  return displayTime <= 5 * 60 && !isOvertime
}

/**
 * Calculate display time (absolute value for overtime, max 0 for countdown)
 */
export function calculateDisplayTime(remainingSeconds: number): number {
  const isOvertime = remainingSeconds < 0
  return isOvertime ? Math.abs(remainingSeconds) : Math.max(0, remainingSeconds)
}

/**
 * Check if timer is in overtime state
 */
export function checkIsOvertime(remainingSeconds: number): boolean {
  return remainingSeconds < 0
}
