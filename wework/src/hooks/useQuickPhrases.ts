import { useEffect, useState } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultQuickPhrases,
  getAppPreferences,
  type AppPreferences,
  type QuickPhrase,
} from '@/desktop/appPreferences'

export function useQuickPhrases(): QuickPhrase[] {
  const sharedPreferences = useAppPreferencesState()
  const [phrases, setPhrases] = useState(defaultQuickPhrases)

  useEffect(() => {
    if (sharedPreferences) return
    let active = true
    let hasReceivedEvent = false
    void getAppPreferences()
      .then(preferences => {
        if (active && !hasReceivedEvent) setPhrases(preferences.quickPhrases)
      })
      .catch(error => {
        console.error('[Wework] Failed to load quick phrases:', error)
      })
    const handleChange = (event: Event) => {
      hasReceivedEvent = true
      setPhrases((event as CustomEvent<AppPreferences>).detail.quickPhrases)
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handleChange)
    return () => {
      active = false
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handleChange)
    }
  }, [sharedPreferences])

  return sharedPreferences?.preferences.quickPhrases ?? phrases
}
