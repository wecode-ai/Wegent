// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef, useEffect, useState } from 'react'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface UseAutoSaveOptions<T> {
  onSave: (data: T) => Promise<void>
  delay?: number // milliseconds, default 2000
  enabled?: boolean // default true
}

interface UseAutoSaveReturn<T> {
  triggerSave: (data: T) => void
  flushSave: () => Promise<void>
  saveStatus: SaveStatus
  lastSavedAt: Date | null
  manualSave: (data: T) => Promise<void>
}

/**
 * Hook for debounced auto-save functionality with status tracking.
 *
 * Features:
 * - Debounced auto-save (triggers after delay of no changes)
 * - Manual save (for explicit save buttons)
 * - Status tracking (idle/saving/saved/error)
 * - Last saved timestamp
 * - Flush pending saves on unmount
 */
export function useAutoSave<T>({
  onSave,
  delay = 2000,
  enabled = true,
}: UseAutoSaveOptions<T>): UseAutoSaveReturn<T> {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingDataRef = useRef<T | null>(null)
  const onSaveRef = useRef(onSave)

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  // Keep onSave ref up to date
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  // Clear timeout on unmount and flush any pending save
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      // Flush pending save on unmount
      if (pendingDataRef.current !== null) {
        onSaveRef.current(pendingDataRef.current)
      }
    }
  }, [])

  const performSave = useCallback(async (data: T): Promise<void> => {
    setSaveStatus('saving')
    try {
      await onSaveRef.current(data)
      setSaveStatus('saved')
      setLastSavedAt(new Date())
      // Reset to idle after 3 seconds
      setTimeout(() => {
        setSaveStatus(current => (current === 'saved' ? 'idle' : current))
      }, 3000)
    } catch (error) {
      setSaveStatus('error')
      console.error('Auto-save failed:', error)
    }
  }, [])

  const triggerSave = useCallback(
    (data: T) => {
      if (!enabled) return

      // Store the latest data
      pendingDataRef.current = data

      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }

      // Set new timeout
      timeoutRef.current = setTimeout(async () => {
        if (pendingDataRef.current !== null) {
          const dataToSave = pendingDataRef.current
          pendingDataRef.current = null
          await performSave(dataToSave)
        }
      }, delay)
    },
    [delay, enabled, performSave]
  )

  const flushSave = useCallback(async (): Promise<void> => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    if (pendingDataRef.current !== null) {
      const dataToSave = pendingDataRef.current
      pendingDataRef.current = null
      await performSave(dataToSave)
    }
  }, [performSave])

  const manualSave = useCallback(
    async (data: T): Promise<void> => {
      // Clear any pending auto-save
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      pendingDataRef.current = null
      await performSave(data)
    },
    [performSave]
  )

  return {
    triggerSave,
    flushSave,
    saveStatus,
    lastSavedAt,
    manualSave,
  }
}
