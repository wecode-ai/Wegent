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
export async function prepareIssueStartStatus(
  issues: Pick<SharedWorkspaceApi['issues'], 'get' | 'update'>,
  issueId: string,
  context: {
    projectStore: CollaborationProject['project_store']
    dispatchRoundId?: string | null
  }
): Promise<{ error: string | null; rollback?: () => Promise<void> }> {
  // The reserved direct round is a personal assignment, without a group manager.
  const managedRound = context.dispatchRoundId && context.dispatchRoundId !== 'direct'
  if (context.projectStore === 'local' || managedRound) return { error: null }
  try {
    const latest = await issues.get(issueId)
    if (['inbox', 'pending', 'in_review'].includes(latest.status)) {
      const previousStatus = latest.status
      const { version: startedVersion } = await persistIssueDetailFields(
        latest,
        { status: 'in_progress' },
        issues
      )
      return {
        error: null,
        rollback: async () => {
          const current = await issues.get(issueId)
          // Never undo a newer comment, assignment, or lifecycle transition.
          if (current.version !== startedVersion || current.status !== 'in_progress') return
          await issues.update(issueId, { version: current.version, status: previousStatus })
        },
      }
    }
    return { error: null }
  } catch (error) {
    return { error: error instanceof Error ? error.message : '' }
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
