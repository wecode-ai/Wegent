import { useMemo } from 'react'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import type { ExperienceSource } from './useExperienceSources'
import { useExperienceSourceReads, type ExperienceReadOwner } from './useExperienceSourceReads'

async function readProject({ source, key }: ExperienceReadOwner) {
  const project = await source.api.projects.get(key)
  if (project.id !== key || project.project_store !== source.store)
    throw Object.assign(new Error('Project source does not match My work'), {
      code: 'source_mismatch',
    })
  return project
}

/** My work establishes a project identity independently of navigation catalogs. */
export function useExperienceProjectHydration(
  sources: ExperienceSource[],
  catalog: readonly { source: ExperienceSource; projects: CollaborationProject[] }[],
  work: readonly { api: SharedWorkspaceApi; items: WorkspaceMyWorkItem[] }[],
  active: boolean,
  revision: number,
  scopeKey: string
) {
  const missingIds = JSON.stringify(
    sources.map(source => {
      const known = new Set(
        catalog.find(row => row.source === source)?.projects.map(project => project.id)
      )
      return [
        ...new Set(
          work
            .find(row => row.api === source.api)
            ?.items.map(issue => issue.cloud_project_id)
            .filter(id => id && !known.has(id)) ?? []
        ),
      ].sort()
    })
  )
  const owners = useMemo(
    () =>
      sources.flatMap((source, index) =>
        (JSON.parse(missingIds) as string[][])[index].map(key => ({ source, key }))
      ),
    [sources, missingIds]
  )
  const result = useExperienceSourceReads(sources, owners, active, revision, scopeKey, readProject)
  return useMemo(
    () =>
      result.map(row => ({
        source: row.source,
        id: row.key,
        project: row.value,
        error: row.error,
        loading: row.loading,
      })),
    [result]
  )
}
