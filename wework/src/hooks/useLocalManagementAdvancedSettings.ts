import { useCallback, useEffect, useRef, useState } from 'react'

export const LOCAL_MANAGEMENT_ADVANCED_SETTINGS_STORAGE_KEY =
  'wework.localManagement.advancedSettingsEnabled'

const UNLOCK_CLICK_COUNT = 5
const UNLOCK_CLICK_WINDOW_MS = 3_000
const UNLOCK_TOAST_DURATION_MS = 2_500

function readAdvancedSettingsEnabled(): boolean {
  try {
    return (
      window.localStorage.getItem(
        LOCAL_MANAGEMENT_ADVANCED_SETTINGS_STORAGE_KEY,
      ) === 'true'
    )
  } catch {
    return false
  }
}

export function useLocalManagementAdvancedSettings() {
  const [advancedSettingsEnabled, setAdvancedSettingsEnabled] = useState(
    readAdvancedSettingsEnabled,
  )
  const [showAdvancedSettingsToast, setShowAdvancedSettingsToast] =
    useState(false)
  const clickCountRef = useRef(0)
  const clickWindowStartedAtRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const handleTitleClick = useCallback(() => {
    if (advancedSettingsEnabled) return

    const now = Date.now()
    const clickWindowStartedAt = clickWindowStartedAtRef.current
    if (
      clickWindowStartedAt === null ||
      now - clickWindowStartedAt > UNLOCK_CLICK_WINDOW_MS
    ) {
      clickWindowStartedAtRef.current = now
      clickCountRef.current = 1
      return
    }

    clickCountRef.current += 1
    if (clickCountRef.current < UNLOCK_CLICK_COUNT) return

    clickCountRef.current = 0
    clickWindowStartedAtRef.current = null
    setAdvancedSettingsEnabled(true)
    setShowAdvancedSettingsToast(true)

    try {
      window.localStorage.setItem(
        LOCAL_MANAGEMENT_ADVANCED_SETTINGS_STORAGE_KEY,
        'true',
      )
    } catch {
      // Keep advanced settings enabled for the current app session.
    }

    toastTimerRef.current = window.setTimeout(() => {
      setShowAdvancedSettingsToast(false)
      toastTimerRef.current = null
    }, UNLOCK_TOAST_DURATION_MS)
  }, [advancedSettingsEnabled])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  return {
    advancedSettingsEnabled,
    showAdvancedSettingsToast,
    handleTitleClick,
  }
}
