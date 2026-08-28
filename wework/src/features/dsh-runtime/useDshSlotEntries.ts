import { useSyncExternalStore } from 'react'

import {
  getDshSlotEntries,
  subscribeDshSlot,
  type WeworkDshSlotEntry,
  type WeworkDshSlotName,
} from './dshUiSlots'

export function useDshSlotEntries<T extends WeworkDshSlotEntry>(
  slotName: WeworkDshSlotName
): readonly T[] {
  return useSyncExternalStore(
    listener => subscribeDshSlot(slotName, listener),
    () => getDshSlotEntries<T>(slotName),
    () => getDshSlotEntries<T>(slotName)
  )
}
