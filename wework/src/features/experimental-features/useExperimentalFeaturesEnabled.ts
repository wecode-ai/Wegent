import {
  useAppPreferenceFeatureState,
  type AppPreferenceFeatureState,
} from './useAppPreferenceFeatureState'

export type ExperimentalFeaturesState = AppPreferenceFeatureState

export function useExperimentalFeaturesState(): ExperimentalFeaturesState {
  return useAppPreferenceFeatureState('experimentalFeaturesEnabled')
}

export function useExperimentalFeaturesEnabled(): boolean {
  return useExperimentalFeaturesState().enabled
}
