import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
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
  const resource = useMemo(
    () =>
      createAsyncResource<ExperienceIssueData>(
        JSON.stringify([projectId, issueId]),
        async signal => {
          const [project, issue] = await Promise.all([
            source!.api.projects.get(projectId!),
            source!.api.issues.get(issueId!),
          ])
          signal.throwIfAborted()
          if (
            project.id !== projectId ||
            project.project_store !== source!.store ||
            issue.cloud_project_id !== projectId ||
            issue.id !== issueId ||
            !canStartWorkOnCollaborationIssue(issue)
          )
            throw new Error('Issue is unavailable')
          const taskBindings = await source!.api.taskBindings.list(issueId!, projectId!)
          return { project, participationViewer: source!.participationViewer, issue, taskBindings }
        },
        { refreshOnSubscribe: true }
      ),
    [source, projectId, issueId]
  )
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, revision),
    [resource, revision]
  )
  const query = useSyncExternalStore(
    active && source && projectId && issueId ? subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  return {
    owner,
    revision,
    data: query.status === 'error' ? null : (query.data ?? null),
    error:
      query.status === 'error'
        ? query.error instanceof Error
          ? query.error.message
          : String(query.error)
        : null,
    loading: active && Boolean(issueId) && (query.status === 'idle' || query.status === 'loading'),
  }
}
