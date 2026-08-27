import { navigateTo } from '@/lib/navigation'
import { getDshSlotEntries, WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'

export interface WeworkDshAction extends WeworkDshSlotEntry {
  path: string
}

export function executeDshAction(action: WeworkDshAction): void {
  navigateTo(action.path)
}

export function getDshAction(id: string): WeworkDshAction | null {
  return (
    getDshSlotEntries<WeworkDshAction>(WEWORK_DSH_SLOTS.action).find(action => action.id === id) ??
    null
  )
}
