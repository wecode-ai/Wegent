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
  flushSave: () => Promise<T | null>
  saveStatus: SaveStatus
  lastSavedAt: Date | null
  manualSave: (data: T) => Promise<void>
  hasUnsavedChanges: boolean
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
  const hasUnsavedChangesRef = useRef(false)

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  // Track unsaved changes to prevent submission race conditions
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

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
    hasUnsavedChangesRef.current = false
    setHasUnsavedChanges(false)
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
      hasUnsavedChangesRef.current = true
      setHasUnsavedChanges(true)
      console.error('Auto-save failed:', error)
    }
  }, [])

  const triggerSave = useCallback(
    (data: T) => {
      if (!enabled) return

      // Mark that we have unsaved changes
      hasUnsavedChangesRef.current = true
      setHasUnsavedChanges(true)

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

  const flushSave = useCallback(async (): Promise<T | null> => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    if (pendingDataRef.current !== null) {
      const dataToSave = pendingDataRef.current
      pendingDataRef.current = null
      await performSave(dataToSave)
      hasUnsavedChangesRef.current = false
      setHasUnsavedChanges(false)
      return dataToSave
    }
    // Ensure the unsaved changes flag is reset even if there was no pending data
    hasUnsavedChangesRef.current = false
    setHasUnsavedChanges(false)
    return null
  }, [performSave])

  const manualSave = useCallback(
    async (data: T): Promise<void> => {
      // Clear any pending auto-save
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      pendingDataRef.current = null
      hasUnsavedChangesRef.current = false
      setHasUnsavedChanges(false)
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
    hasUnsavedChanges,
  }
}
