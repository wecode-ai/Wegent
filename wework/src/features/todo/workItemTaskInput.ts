import type { CloudLoopItem } from '@/api/deliveries'

export function workItemTaskInput(item: Pick<CloudLoopItem, 'title' | 'description'>): string {
  return item.title.trim() || item.description?.trim() || ''
}

export function shouldPrepareWorkItemTask(
  item: Pick<CloudLoopItem, 'assignee_agent_id' | 'assignee_team_id' | 'parent_id' | 'status'>,
  previousStatus: string,
  taskBindingCount: number
): boolean {
  return (
    !item.assignee_agent_id &&
    !item.assignee_team_id &&
    item.parent_id === null &&
    item.status !== previousStatus &&
    taskBindingCount === 0
  )
}
