import type { StandInInboxWork } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { createStandInOpenedReceipt } from '@/telemetry/standInOpenedReceipt'

interface SelectionObservation {
  items: RuntimeTaskReminderItem[]
  inbox: StandInInboxWork[]
  active: boolean
}

/** Selection belongs to the work list, including retained inactive visits. */
export function createStandInWorkSelectionSource() {
  let selectedKey: string | null = null
  let observation: SelectionObservation | undefined
  const listeners = new Set<() => void>()
  const recordOpened = createStandInOpenedReceipt()
  const recordVisit = () => {
    if (!listeners.size || !observation) return
    const selected = observation.items.find(item => item.key === selectedKey)
    const work = observation.inbox.find(work => work.taskId === selected?.task.taskId)
    const origin = selected?.task.runtimeHandle?.origin as { standInId?: string | null } | undefined
    const identity = (work?.roleId ?? origin?.standInId) === '@primary' ? 'primary' : 'role'
    recordOpened('work', identity, observation.active && !!selected, selected?.key)
  }
  return {
    getSnapshot: () => selectedKey,
    subscribe(owner: SelectionObservation, listener: () => void) {
      observation = owner
      listeners.add(listener)
      recordVisit()
      return () => {
        listeners.delete(listener)
      }
    },
    select(key: string | null) {
      if (!listeners.size || key === selectedKey) return
      selectedKey = key
      recordVisit()
      for (const listener of listeners) listener()
    },
  }
}
