import type { CloudLoopItem, CloudProject } from '@/api/deliveries'

export function workItemComposerReference(
  project: Pick<CloudProject, 'id' | 'project_key'>,
  item: Pick<CloudLoopItem, 'id' | 'sequence_number' | 'title'>
): string {
  const projectKey = project.project_key?.trim()
  const issueKey = projectKey ? `${projectKey}-${item.sequence_number}` : `#${item.sequence_number}`
  const title = item.title.replace(/[\[\]\n]/g, ' ').trim()
  const label = title ? `${issueKey} · ${title}` : issueKey
  return `[$${label}](wework-issue://${encodeURIComponent(String(project.id))}/${encodeURIComponent(item.id)})`
}

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
