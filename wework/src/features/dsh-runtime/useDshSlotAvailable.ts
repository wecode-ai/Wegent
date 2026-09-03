import { useDshSlotEntries } from './useDshSlotEntries'
import type { WeworkDshSlotEntry, WeworkDshSlotName } from './dshUiSlots'

export function useDshSlotAvailable(slot: WeworkDshSlotName): boolean {
  return useDshSlotEntries<WeworkDshSlotEntry>(slot).length > 0
}
