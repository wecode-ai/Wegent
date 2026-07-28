import { useEffect, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  getAppPreferences,
  type AppPreferences,
} from '@/tauri/appPreferences'

export function useExperimentalFeaturesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    let preferenceChanged = false

    void getAppPreferences()
      .then(preferences => {
        if (!cancelled && !preferenceChanged) {
          setEnabled(preferences.experimentalFeaturesEnabled)
        }
      })
      .catch(error => {
        console.error('[Wework] Failed to load experimental feature preference', error)
      })

    const handlePreferencesChanged = (event: Event) => {
      preferenceChanged = true
      setEnabled((event as CustomEvent<AppPreferences>).detail.experimentalFeaturesEnabled)
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)

    return () => {
      cancelled = true
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }, [])

  return enabled
}
