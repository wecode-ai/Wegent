import { defaultQuickPhrases, type QuickPhrase } from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'

export function useQuickPhrases(): QuickPhrase[] {
  return useAppPreferencesState()?.preferences.quickPhrases ?? defaultQuickPhrases
}
