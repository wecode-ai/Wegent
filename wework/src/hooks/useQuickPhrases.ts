import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useEffect, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultQuickPhrases,
  getAppPreferences,
  type AppPreferences,
  type QuickPhrase,
} from '@/desktop/appPreferences'

export function useQuickPhrases(): QuickPhrase[] {
  const shared = useAppPreferencesState()
  const [phrases, setPhrases] = useState(defaultQuickPhrases)

  useEffect(() => {
    if (shared) return
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
  }, [shared])

  return shared ? shared.preferences.quickPhrases : phrases
}
