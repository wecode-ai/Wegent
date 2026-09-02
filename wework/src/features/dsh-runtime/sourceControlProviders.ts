import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'
import { useDshSlotEntries } from './useDshSlotEntries'

export interface WeworkSourceControlProvider extends WeworkDshSlotEntry {
  workspaceModes?: readonly string[]
}

export function useSourceControlProviderInstalled(providerId: string): boolean {
  const providers = useDshSlotEntries<WeworkSourceControlProvider>(
    WEWORK_DSH_SLOTS.sourceControlProvider
  )
  return providers.some(provider => provider.id === providerId)
}

export function useWorkspaceModeProviderInstalled(workspaceMode: string): boolean {
  const providers = useDshSlotEntries<WeworkSourceControlProvider>(
    WEWORK_DSH_SLOTS.sourceControlProvider
  )
  return providers.some(provider => provider.workspaceModes?.includes(workspaceMode))
}
