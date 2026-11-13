import { useEffect, useMemo, useState } from 'react'
import { canStartWorkOnCollaborationIssue } from '@wegent/collaboration'
import type {
  CollaborationIssue,
  CollaborationProject,
  IssueParticipationViewer,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import type { ExperienceSource } from './useExperienceSources'

export interface ExperienceIssueData {
  project: CollaborationProject
  participationViewer?: IssueParticipationViewer
  issue: CollaborationIssue
  taskBindings: WorkspaceTaskBinding[]
}

export function useExperienceIssue(
  source: ExperienceSource | undefined,
  projectId: string | null,
  issueId: string | null,
  active: boolean,
  revision: number
) {
  const owner = useMemo(() => ({ source, projectId, issueId }), [source, projectId, issueId])
  const [snapshot, setSnapshot] = useState<{
    owner: typeof owner
    data: ExperienceIssueData | null
    error: string | null
    revision: number
  }>({ owner, data: null, error: null, revision: -1 })
  useEffect(() => {
    if (!active || !source || !projectId || !issueId) return
    let cancelled = false
    void Promise.all([source.api.projects.get(projectId), source.api.issues.get(issueId)])
      .then(async ([project, issue]) => {
        if (
          project.id !== projectId ||
          project.project_store !== source.store ||
          issue.cloud_project_id !== projectId ||
          issue.id !== issueId ||
          !canStartWorkOnCollaborationIssue(issue)
        )
          throw new Error('Issue is unavailable')
        if (cancelled) return
        const taskBindings = await source.api.taskBindings.list(issueId, projectId)
        if (!cancelled)
          setSnapshot({
            owner,
            data: { project, participationViewer: source.participationViewer, issue, taskBindings },
            error: null,
            revision,
          })
      })
      .catch(cause => {
        if (!cancelled)
          setSnapshot({
            owner,
            data: null,
            error: cause instanceof Error ? cause.message : String(cause),
            revision,
          })
      })
    return () => {
      cancelled = true
    }
  }, [owner, source, projectId, issueId, active, revision])
  return snapshot.owner === owner
    ? {
        ...snapshot,
        loading: active && snapshot.revision !== revision,
        error: snapshot.revision === revision ? snapshot.error : null,
      }
    : { owner, data: null, error: null, loading: active && Boolean(issueId) }
}
