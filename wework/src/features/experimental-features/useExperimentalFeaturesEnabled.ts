import { useEffect, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  getAppPreferences,
  type AppPreferences,
} from '@/tauri/appPreferences'

export interface ExperimentalFeaturesState {
  enabled: boolean
  loaded: boolean
}

export function useExperimentalFeaturesState(): ExperimentalFeaturesState {
  const [state, setState] = useState<ExperimentalFeaturesState>({
    enabled: false,
    loaded: false,
  })

  useEffect(() => {
    let cancelled = false
    let preferenceChanged = false

    void getAppPreferences()
      .then(preferences => {
        if (!cancelled && !preferenceChanged) {
          setState({
            enabled: preferences.experimentalFeaturesEnabled,
            loaded: true,
          })
        }
      })
      .catch(error => {
        console.error('[Wework] Failed to load experimental feature preference', error)
        if (!cancelled && !preferenceChanged) {
          setState({ enabled: false, loaded: true })
        }
      })

    const handlePreferencesChanged = (event: Event) => {
      preferenceChanged = true
      setState({
        enabled: (event as CustomEvent<AppPreferences>).detail.experimentalFeaturesEnabled,
        loaded: true,
      })
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)

    return () => {
      cancelled = true
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }, [])

  return state
}

export function useExperimentalFeaturesEnabled(): boolean {
  return useExperimentalFeaturesState().enabled
}
