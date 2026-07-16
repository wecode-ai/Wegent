import { useEffect, useState } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultQuickPhrases,
  getAppPreferences,
  type AppPreferences,
  type QuickPhrase,
} from '@/tauri/appPreferences'

export function useQuickPhrases(): QuickPhrase[] {
  const [phrases, setPhrases] = useState(defaultQuickPhrases)

  useEffect(() => {
    let active = true
    void getAppPreferences().then(preferences => {
      if (active) setPhrases(preferences.quickPhrases)
    })
    const handleChange = (event: Event) => {
      setPhrases((event as CustomEvent<AppPreferences>).detail.quickPhrases)
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handleChange)
    return () => {
      active = false
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handleChange)
    }
  }, [])

  return phrases
}
