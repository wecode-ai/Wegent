import type { CollaborationProject } from '../types'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { persistIssueDetailFields } from './persistIssueDetailFields'

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
