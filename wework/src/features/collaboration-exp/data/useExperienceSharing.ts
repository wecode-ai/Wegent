import { useMemo } from 'react'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import { isExperienceIssueRelatedToViewer } from '../model/taskSelectors'
import { projectViewer } from '../model/sourceIdentity'
import type { ExperienceSource } from './useExperienceSources'
import { useExperienceSourceReads, type ExperienceReadOwner } from './useExperienceSourceReads'

async function readCollaborators({ source, key }: ExperienceReadOwner) {
  const [, issueId] = JSON.parse(key) as [string, string]
  if (!source.api.collaborators) throw new Error('Issue sharing service is unavailable')
  return (await source.api.collaborators.list(issueId)).filter(row => row.issueId === issueId)
}

/** Only loaded My work candidates without existing ownership proof need sharing reads. */
export function useExperienceSharing(
  sources: ExperienceSource[],
  catalog: readonly { source: ExperienceSource; projects: CollaborationProject[] }[],
  work: readonly { api: SharedWorkspaceApi; items: WorkspaceMyWorkItem[] }[],
  viewerIds: readonly (string | number)[],
  active: boolean,
  revision: number
) {
  const candidates = JSON.stringify(
    sources.map(source => {
      const projects = catalog.find(row => row.source === source)?.projects ?? []
      return [
        ...new Set(
          (work.find(row => row.api === source.api)?.items ?? []).flatMap(issue => {
            const project = projects.find(candidate => candidate.id === issue.cloud_project_id)
            return project &&
              issue.can_view_detail !== false &&
              !isExperienceIssueRelatedToViewer(issue, projectViewer(project, viewerIds))
              ? [JSON.stringify([project.id, issue.id])]
              : []
          })
        ),
      ].sort()
    })
  )
  const owners = useMemo(
    () =>
      sources.flatMap((source, index) =>
        (JSON.parse(candidates) as string[][])[index].map(key => ({ source, key }))
      ),
    [sources, candidates]
  )
  return useExperienceSourceReads(
    sources,
    owners,
    active,
    revision,
    JSON.stringify(viewerIds),
    readCollaborators
  )
}
