import { useEffect, useState } from 'react'

import { importDshUiModule } from './dshUiModules'
import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'
import { useDshSlotEntries } from './useDshSlotEntries'

interface HomeModuleEntry extends WeworkDshSlotEntry {
  module?: string
}

export function useDshTaskHomeModules(active: boolean): void {
  const entries = useDshSlotEntries<HomeModuleEntry>(WEWORK_DSH_SLOTS.home)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (!active) return
    let current = true
    // The active task surface needs its home contributions alongside the app module.
    // Request them before the app's nested empty-task launcher mounts.
    void Promise.all(
      entries.flatMap(entry => (entry.module ? [importDshUiModule(entry.module)] : []))
    ).catch(reason => {
      if (current) setError(reason)
    })
    return () => {
      current = false
    }
  }, [active, entries])

  if (active && error) throw error
}
