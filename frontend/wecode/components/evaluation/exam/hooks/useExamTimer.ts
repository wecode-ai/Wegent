import { useState, useEffect, useMemo } from 'react'

import type { ExamSessionStatus } from '@wecode/types/evaluation-exam'

export type ExamPhase = 'ready' | 'intro' | 'exam' | 'review' | 'completed'

interface UseExamTimerOptions {
  session: ExamSessionStatus | null
}

interface UseExamTimerReturn {
  phase: ExamPhase
  remainingSeconds: number
  elapsedSeconds: number
  formattedTime: string
  isOvertime: boolean
  isCompleted: boolean
  submitCount: number
  selectedQuestionId: number | null
  showTimer: boolean
}

/**
 * Hook for managing exam timer with server-synchronized time.
 *
 * CRITICAL: This hook does NOT calculate remaining time locally.
 * It uses the remaining_seconds value directly from the server response.
 * This avoids all timezone issues between frontend and backend.
 *
 * The hook only decrements the remaining_seconds locally for display purposes,
 * but the authoritative value always comes from the server.
 *
 * Only shows timer during 'exam' phase. When exam time expires,
 * switches to overtime counting (positive elapsed time) with red styling.
 *
 * No automatic phase transitions - users must manually click to advance.
 */
export function useExamTimer({ session }: UseExamTimerOptions): UseExamTimerReturn {
  const [phase, setPhase] = useState<ExamPhase>(session?.phase || 'ready')
  const [remainingSeconds, setRemainingSeconds] = useState(session?.remaining_seconds || 0)

  // Sync with server session when it changes
  useEffect(() => {
    if (session) {
      setPhase(session.phase)
      setRemainingSeconds(session.remaining_seconds)
    }
  }, [session])

  // Local countdown - just decrement the server-provided value
  // This is only for display smoothness, actual value comes from server
  useEffect(() => {
    if (phase !== 'exam') return

    const interval = setInterval(() => {
      setRemainingSeconds(prev => prev - 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [phase])

  // Calculate elapsed time for overtime display
  const elapsedSeconds = useMemo(() => {
    if (remainingSeconds >= 0) return 0
    return Math.abs(remainingSeconds)
  }, [remainingSeconds])

  const isOvertime = remainingSeconds < 0

  // Only show timer during exam phase
  const showTimer = phase === 'exam'

  // Format time display: countdown if time remaining, elapsed if overtime
  const formattedTime = useMemo(() => {
    const seconds = isOvertime ? elapsedSeconds : Math.max(0, remainingSeconds)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    const sign = isOvertime ? '+' : ''
    return `${sign}${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }, [remainingSeconds, elapsedSeconds, isOvertime])

  return {
    phase,
    remainingSeconds,
    elapsedSeconds,
    formattedTime,
    isOvertime,
    isCompleted: phase === 'completed',
    submitCount: session?.submit_count || 0,
    selectedQuestionId: session?.selected_question_id || null,
    showTimer,
  }
}
