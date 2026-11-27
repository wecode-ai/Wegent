import { connectionObservationHealth } from '@/features/workbench/resourceObservation'
import type { ConnectionEventSubscription } from './runtime-connection-events'

export function sidebarEventState(item: ConnectionEventSubscription) {
  if (['error', 'needs_attention'].includes(item.status)) return 'execution_error'
  if (['pending', 'resuming_goal'].includes(item.status)) return 'received'
  if (connectionObservationHealth(item).error) return 'observation_error'
  return item.status === 'preparing' ? 'preparing' : 'waiting'
}

export function preferredEventSubscription(items: ConnectionEventSubscription[]) {
  const priority = {
    execution_error: 0,
    received: 1,
    observation_error: 2,
    preparing: 3,
    waiting: 4,
  }
  let selected: ConnectionEventSubscription | undefined
  let rank = Infinity
  for (const item of items) {
    const next = priority[sidebarEventState(item)]
    if (next < rank) {
      selected = item
      rank = next
    }
  }
  return selected
}
