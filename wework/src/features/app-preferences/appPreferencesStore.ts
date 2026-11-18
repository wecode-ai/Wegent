import { applyLanguagePreference } from '@/i18n/languagePreference'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  emitAppPreferencesChanged,
  getAppPreferences,
  mergeAppPreferences,
} from '@/desktop/appPreferences'
import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { AppPreferencesState } from './appPreferencesContext'

export function createAppPreferencesStore(ownsLanguage = false) {
  let snapshot: AppPreferencesState = { preferences: defaultAppPreferences, loaded: false }
  let generation = 0
  const listeners = new Set<() => void>()
  let appliedLanguage: AppPreferencesState['preferences']['language'] | undefined
  const publish = (state: AppPreferencesState) => {
    if (ownsLanguage && state.loaded && state.preferences.language !== appliedLanguage) {
      appliedLanguage = state.preferences.language
      void applyLanguagePreference(appliedLanguage).catch(error => {
        console.error('[Wework] Failed to apply language preference:', error)
      })
    }
    snapshot = state
    listeners.forEach(listener => listener())
  }
  const connect = () => {
    const requestGeneration = ++generation
    let preferenceChanged = false
    const handlePreferencesChanged = (event: Event) => {
      preferenceChanged = true
      publish({
        preferences: (event as CustomEvent<AppPreferencesState['preferences']>).detail,
        loaded: true,
      })
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    const unsubscribe = isElectronRuntime()
      ? subscribeDesktopHostEvents(event => {
          if (event.type === 'preferences.changed')
            emitAppPreferencesChanged(mergeAppPreferences(event.payload))
        })
      : undefined
    void getAppPreferences()
      .then(preferences => {
        if (requestGeneration === generation && !preferenceChanged)
          publish({ preferences, loaded: true })
      })
      .catch(error => {
        console.error('[Wework] Failed to load app preferences:', error)
        if (requestGeneration === generation && !preferenceChanged)
          publish({ preferences: defaultAppPreferences, loaded: true })
      })
    return () => {
      generation++
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
      unsubscribe?.()
    }
  }
  let disconnect: (() => void) | undefined
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (listeners.size === 1) disconnect = connect()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          disconnect?.()
          disconnect = undefined
        }
      }
    },
  }
}
