import { useEffect, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultQuickPhrases,
  getAppPreferences,
  type AppPreferences,
  type QuickPhrase,
} from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'

export function useQuickPhrases(): QuickPhrase[] {
  const appPreferences = useAppPreferencesState()
  const [phrases, setPhrases] = useState(defaultQuickPhrases)

  useEffect(() => {
    if (appPreferences) return

    let active = true
    let hasReceivedEvent = false
    void getAppPreferences().then(preferences => {
      if (active && !hasReceivedEvent) setPhrases(preferences.quickPhrases)
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
  }, [appPreferences])

  return appPreferences?.preferences.quickPhrases ?? phrases
}
