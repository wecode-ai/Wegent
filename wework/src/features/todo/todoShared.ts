import type { CloudLoopItem } from '@/api/deliveries'

export const columns: Array<{ status: CloudLoopItem['status']; label: string }> = [
  { status: 'inbox', label: '收集箱' },
  { status: 'pending', label: '待开始' },
  { status: 'in_progress', label: '进行中' },
  { status: 'in_review', label: '待确认' },
  { status: 'completed', label: '已完成' },
]

export const columnDotClasses: Record<CloudLoopItem['status'], string> = {
  inbox: 'bg-zinc-400',
  pending: 'bg-indigo-500',
  in_progress: 'bg-amber-500',
  in_review: 'bg-violet-500',
  completed: 'bg-emerald-500',
}

export const memberAvatarClasses = [
  'bg-gradient-to-br from-indigo-400 to-indigo-500',
  'bg-gradient-to-br from-emerald-400 to-emerald-500',
  'bg-gradient-to-br from-amber-400 to-amber-500',
]

export const priorityBadgeClasses: Record<CloudLoopItem['priority'], string> = {
  none: 'bg-muted text-text-secondary',
  low: 'bg-muted text-text-secondary',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  urgent: 'bg-red-500/10 text-red-600 dark:text-red-400',
}

// Computes the flat item list and lane id order after moving `itemId` into
// the lane identified by its own parent layer and `status`, inserted before
// `beforeItemId` (appended at the end when null). Returns null when the drop
// would not change anything.
export function reorderLaneItems(
  items: CloudLoopItem[],
  itemId: string,
  status: CloudLoopItem['status'],
  beforeItemId: string | null
): { items: CloudLoopItem[]; laneIds: string[] } | null {
  const item = items.find(candidate => candidate.id === itemId)
  if (!item) return null
  const inLane = (candidate: CloudLoopItem) =>
    candidate.parent_id === item.parent_id && candidate.status === status && candidate.id !== itemId
  const currentLaneIds = items.filter(inLane).map(candidate => candidate.id)
  if (item.status === status) {
    // Nothing to do when a plain lane drop keeps the card inside its lane, or
    // when the card is already right before its drop target.
    if (!beforeItemId) return null
    const laneOrder = items.filter(
      candidate => candidate.parent_id === item.parent_id && candidate.status === status
    )
    const itemIndex = laneOrder.findIndex(candidate => candidate.id === itemId)
    if (laneOrder[itemIndex + 1]?.id === beforeItemId) return null
  }
  const laneIds = [...currentLaneIds]
  const beforeIndex = beforeItemId ? laneIds.indexOf(beforeItemId) : -1
  laneIds.splice(beforeIndex >= 0 ? beforeIndex : laneIds.length, 0, itemId)
  const laneItems = new Map(items.filter(inLane).map(candidate => [candidate.id, candidate]))
  laneItems.set(itemId, { ...item, status })
  // Board rendering only depends on the relative order inside each lane, so
  // the reordered lane can move to the end of the flat list as a block.
  return {
    items: [
      ...items.filter(candidate => !inLane(candidate) && candidate.id !== itemId),
      ...laneIds.map(id => laneItems.get(id)!),
    ],
    laneIds,
  }
}
