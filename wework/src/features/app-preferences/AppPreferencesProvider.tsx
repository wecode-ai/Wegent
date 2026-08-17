import { useEffect, useState, type ReactNode } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  getAppPreferences,
} from '@/tauri/appPreferences'
import { AppPreferencesContext, type AppPreferencesState } from './appPreferencesContext'

export function AppPreferencesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppPreferencesState>({
    preferences: defaultAppPreferences,
    loaded: false,
  })

  useEffect(() => {
    let cancelled = false
    let preferenceChanged = false

    void getAppPreferences()
      .then(preferences => {
        if (!cancelled && !preferenceChanged) {
          setState({ preferences, loaded: true })
        }
      })
      .catch(error => {
        console.error('[Wework] Failed to load app preferences:', error)
        if (!cancelled && !preferenceChanged) {
          setState({ preferences: defaultAppPreferences, loaded: true })
        }
      })

    const handlePreferencesChanged = (event: Event) => {
      preferenceChanged = true
      setState({
        preferences: (event as CustomEvent<AppPreferencesState['preferences']>).detail,
        loaded: true,
      })
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)

    return () => {
      cancelled = true
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }, [])

  return <AppPreferencesContext.Provider value={state}>{children}</AppPreferencesContext.Provider>
}
