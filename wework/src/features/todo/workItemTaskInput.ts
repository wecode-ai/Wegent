import type { CloudLoopItem } from '@/api/deliveries'

type TaskEntryStatus = 'pending' | 'in_progress'

export function workItemTaskInput(item: Pick<CloudLoopItem, 'title' | 'description'>): string {
  return item.title.trim() || item.description?.trim() || ''
}

export function shouldPrepareWorkItemTask(
  item: Pick<CloudLoopItem, 'parent_id' | 'status'>,
  targetStatus: TaskEntryStatus,
  taskBindingCount: number
): boolean {
  return item.parent_id === null && item.status !== targetStatus && taskBindingCount === 0
}
