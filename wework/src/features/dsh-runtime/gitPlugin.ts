import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import { useDshSlotEntries } from './useDshSlotEntries'

export const GIT_CONTRIBUTION_ID = 'git'

export function useGitPluginInstalled(): boolean {
  const contributions = useDshSlotEntries(WEWORK_DSH_SLOTS.git)
  return contributions.some(contribution => contribution.id === GIT_CONTRIBUTION_ID)
}

export function useChangeRequestStatusEnabled(): boolean {
  const installed = useGitPluginInstalled()
  const preferences = useAppPreferencesState()
  return installed && (preferences?.preferences.changeRequestStatusEnabled ?? true)
}
