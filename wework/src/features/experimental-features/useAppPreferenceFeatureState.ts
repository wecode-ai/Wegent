import { useEffect, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  getAppPreferences,
  type AppPreferences,
} from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'

export interface AppPreferenceFeatureState {
  enabled: boolean
  loaded: boolean
}

export function useAppPreferenceFeatureState(
  preference: 'experimentalFeaturesEnabled' | 'collaborationExperienceEnabled'
): AppPreferenceFeatureState {
  const appPreferences = useAppPreferencesState()
  const [fallbackState, setFallbackState] = useState<AppPreferenceFeatureState>({
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
            enabled: preferences[preference] === true,
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
        enabled: (event as CustomEvent<AppPreferences>).detail[preference] === true,
        loaded: true,
      })
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)

    return () => {
      cancelled = true
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }, [appPreferences, preference])

  if (appPreferences) {
    return {
      enabled: appPreferences.preferences[preference] === true,
      loaded: appPreferences.loaded,
    }
  }

  return fallbackState
}
