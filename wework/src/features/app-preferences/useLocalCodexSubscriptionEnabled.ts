import { defaultAppPreferences } from '@/desktop/appPreferences'
import { useAppPreferencesState } from './useAppPreferencesState'

/**
 * Normalized local Codex subscription preference shared by every surface that
 * hides Codex UI while the subscription is off. Falls back to the default
 * (enabled) when the preferences provider is absent (e.g. legacy tests) or
 * has not loaded yet, matching the model settings page behavior.
 */
export function useLocalCodexSubscriptionEnabled(): { enabled: boolean; loaded: boolean } {
  const appPreferences = useAppPreferencesState()
  if (!appPreferences) {
    return { enabled: true, loaded: true }
  }
  return {
    enabled: appPreferences.loaded
      ? appPreferences.preferences.localCodexSubscriptionEnabled
      : defaultAppPreferences.localCodexSubscriptionEnabled,
    loaded: appPreferences.loaded,
  }
}
