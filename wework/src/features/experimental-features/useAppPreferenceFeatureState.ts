import { useMemo, useSyncExternalStore } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { createAppPreferencesStore } from '@/features/app-preferences/appPreferencesStore'

export interface AppPreferenceFeatureState {
  enabled: boolean
  loaded: boolean
}

const noSubscription = () => () => {}

export function useAppPreferenceFeatureState(
  preference: 'experimentalFeaturesEnabled' | 'collaborationExperienceEnabled'
): AppPreferenceFeatureState {
  const appPreferences = useAppPreferencesState()
  const store = useMemo(() => createAppPreferencesStore(), [])
  const externalState = useSyncExternalStore(
    appPreferences ? noSubscription : store.subscribe,
    store.getSnapshot
  )
  const state = appPreferences ?? externalState
  return { enabled: state.preferences[preference] === true, loaded: state.loaded }
}
