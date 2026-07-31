import { useEffect, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  getAppPreferences,
  type AppPreferences,
} from '@/tauri/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'

export interface ExperimentalFeaturesState {
  enabled: boolean
  loaded: boolean
}

export function useExperimentalFeaturesState(): ExperimentalFeaturesState {
  const appPreferences = useAppPreferencesState()
  const [fallbackState, setFallbackState] = useState<ExperimentalFeaturesState>({
    enabled: false,
    loaded: false,
  })

  useEffect(() => {
    if (appPreferences) return undefined

    let cancelled = false
    let preferenceChanged = false

    void getAppPreferences()
      .then(preferences => {
        if (!cancelled && !preferenceChanged) {
          setFallbackState({
            enabled: preferences.experimentalFeaturesEnabled,
            loaded: true,
          })
        }
      })
      .catch(error => {
        console.error('[Wework] Failed to load experimental feature preference', error)
        if (!cancelled && !preferenceChanged) {
          setFallbackState({ enabled: false, loaded: true })
        }
      })

    const handlePreferencesChanged = (event: Event) => {
      preferenceChanged = true
      setFallbackState({
        enabled: (event as CustomEvent<AppPreferences>).detail.experimentalFeaturesEnabled,
        loaded: true,
      })
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)

    return () => {
      cancelled = true
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }, [appPreferences])

  if (appPreferences) {
    return {
      enabled: appPreferences.preferences.experimentalFeaturesEnabled,
      loaded: appPreferences.loaded,
    }
  }

  return fallbackState
}

export function useExperimentalFeaturesEnabled(): boolean {
  return useExperimentalFeaturesState().enabled
}
