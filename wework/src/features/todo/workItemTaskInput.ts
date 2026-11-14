import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  persistIssueDetailFields,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

export function workItemComposerReference(
  project: Pick<CloudProject, 'id' | 'project_key'>,
  item: Pick<CloudLoopItem, 'id' | 'sequence_number' | 'title'>
): string {
  const projectKey = project.project_key?.trim()
  const issueKey = projectKey ? `${projectKey}-${item.sequence_number}` : `#${item.sequence_number}`
  const title = item.title.replace(/[[\]\\\r\n]/g, ' ').trim()
  const label = title ? `${issueKey} · ${title}` : issueKey
  return `[$${label}](wework-issue://${encodeURIComponent(String(project.id))}/${encodeURIComponent(item.id)})`
}

export function workItemTaskInput(item: Pick<CloudLoopItem, 'title' | 'description'>): string {
  return item.title.trim() || item.description?.trim() || ''
}

export function workItemAssociationUpdate(
  item: { tags?: string[] | null; version: number },
  associatedTags: string[]
): { version: number; tags: string[] } | null {
  const currentTags = item.tags ?? []
  const associationChanged =
    associatedTags.length !== currentTags.length ||
    associatedTags.some((tag, index) => tag !== currentTags[index])
  if (!associationChanged) return null
  return {
    version: item.version,
    tags: associatedTags,
  }
}

/** Local lifecycle projection and collaboration managers own their Issue states. */
export async function updateIssueWhenPersonalTaskStarts(
  issues: Pick<SharedWorkspaceApi['issues'], 'get' | 'update'>,
  issueId: string,
  context: {
    projectStore: CollaborationProject['project_store']
    dispatch?: { dispatchId: string } | null
  }
): Promise<string | null> {
  if (context.projectStore === 'local' || context.dispatch) return null
  try {
    const latest = await issues.get(issueId)
    if (['inbox', 'pending', 'in_review'].includes(latest.status)) {
      await persistIssueDetailFields(latest, { status: 'in_progress' }, issues)
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : ''
  }
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
