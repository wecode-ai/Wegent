import { applyLanguagePreference } from '@/i18n/languagePreference'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  emitAppPreferencesChanged,
  getReadableAppPreferences,
  mergeAppPreferences,
} from '@/desktop/appPreferences'
import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { deliverRuntimeTransport } from '@/e2e/runtime-transport-gates'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { AppPreferencesState } from './appPreferencesContext'

export function createAppPreferencesStore(ownsLanguage = false) {
  let generation = 0
  const listeners = new Set<() => void>()
  let appliedLanguage: AppPreferencesState['preferences']['language'] | undefined
  let snapshot: AppPreferencesState = {
    preferences: defaultAppPreferences,
    loaded: false,
    loadStatus: 'loading',
    retry,
  }
  const publish = (state: AppPreferencesState) => {
    if (
      ownsLanguage &&
      state.loadStatus === 'ready' &&
      state.preferences.language !== appliedLanguage
    ) {
      appliedLanguage = state.preferences.language
      void applyLanguagePreference(appliedLanguage).catch(error => {
        console.error('[Wework] Failed to apply language preference:', error)
      })
    }
    snapshot = state
    listeners.forEach(listener => listener())
  }
  async function readPreferences() {
    const requestGeneration = ++generation
    try {
      const preferences = await getReadableAppPreferences()
      if (requestGeneration === generation) {
        publish({ preferences, loaded: true, loadStatus: 'ready', retry })
      }
    } catch (error) {
      if (requestGeneration === generation) {
        console.error('[Wework] Failed to load app preferences:', error)
        publish({ ...snapshot, loaded: true, loadStatus: 'error' })
      }
    }
  }
  function retry() {
    if (snapshot.loadStatus !== 'error') return
    publish({ ...snapshot, loadStatus: 'loading' })
    void readPreferences()
  }
  const connect = () => {
    const handlePreferencesChanged = (event: Event) => {
      const preferences = (event as CustomEvent<AppPreferencesState['preferences']>).detail
      const apply = () => {
        if (!listeners.size) return
        generation++
        publish({ preferences, loaded: true, loadStatus: 'ready', retry })
      }
      if (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true')
        deliverRuntimeTransport('event', APP_PREFERENCES_CHANGED_EVENT, {}, apply)
      else apply()
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    const unsubscribe = isElectronRuntime()
      ? subscribeDesktopHostEvents(event => {
          if (event.type === 'preferences.changed')
            emitAppPreferencesChanged(mergeAppPreferences(event.payload))
        })
      : undefined
    void readPreferences()
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
