import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
import { usePersonalHomeIssues } from '@/features/todo/usePersonalHomeIssues'
import {
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
} from '@/features/todo/projectSpaceSelection'
import type { ExperienceProjectData } from '../model/types'
import type { ExperienceSource } from './useExperienceSources'
import { useExperienceProjectHydration } from './useExperienceProjectHydration'
import { useExperienceTaskSubscriptions } from './useExperienceTaskSubscriptions'
import { useExperienceSharing } from './useExperienceSharing'

interface CatalogSnapshot {
  source: ExperienceSource
  projects: CollaborationProject[]
  loading: boolean
  error: string | null
  revision: number
}

interface AllIssuesSnapshot {
  source: ExperienceSource
  project: CollaborationProject
  issues: ExperienceProjectData['issues']
  loading: boolean
  error: string | null
  revision: number
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

function useExperienceCatalog(sources: ExperienceSource[], active: boolean, revision: number) {
  const [snapshots, setSnapshots] = useState<CatalogSnapshot[]>([])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    for (const source of sources) {
      void source.api.projects.list().then(
        projects => {
          if (!cancelled)
            setSnapshots(previous => [
              ...previous.filter(row => row.source !== source),
              {
                source,
                projects,
                loading: false,
                error: null,
                revision,
              },
            ])
        },
        cause => {
          if (!cancelled)
            setSnapshots(previous => [
              ...previous.filter(row => row.source !== source),
              {
                source,
                projects: previous.find(row => row.source === source)?.projects ?? [],
                loading: false,
                error: errorText(cause),
                revision,
              },
            ])
        }
      )
    }
    return () => {
      cancelled = true
    }
  }, [sources, active, revision])
  return useMemo(
    () =>
      sources.map(source =>
        snapshots.find(row => row.source === source)
          ? {
              ...snapshots.find(row => row.source === source)!,
              loading:
                active && snapshots.find(row => row.source === source)!.revision !== revision,
            }
          : {
              source,
              projects: [],
              loading: active,
              error: null,
              revision,
            }
      ),
    [sources, snapshots, active, revision]
  )
}

function useAllProjectIssues(catalog: CatalogSnapshot[], active: boolean, revision: number) {
  const [snapshots, setSnapshots] = useState<AllIssuesSnapshot[]>([])
  const owners = useMemo(
    () => catalog.flatMap(row => row.projects.map(project => ({ source: row.source, project }))),
    [catalog]
  )
  useEffect(() => {
    if (!active) return
    let cancelled = false
    for (const { source, project } of owners) {
      void source.api.issues.list(project.id).then(
        issues => {
          if (!cancelled)
            setSnapshots(previous => [
              ...previous.filter(row => row.source !== source || row.project.id !== project.id),
              {
                source,
                project,
                issues,
                loading: false,
                error: null,
                revision,
              },
            ])
        },
        cause => {
          if (!cancelled)
            setSnapshots(previous => [
              ...previous.filter(row => row.source !== source || row.project.id !== project.id),
              {
                source,
                project,
                issues:
                  previous.find(row => row.source === source && row.project.id === project.id)
                    ?.issues ?? [],
                loading: false,
                error: errorText(cause),
                revision,
              },
            ])
        }
      )
    }
    return () => {
      cancelled = true
    }
  }, [owners, active, revision])
  return owners.map(owner => {
    const snapshot = snapshots.find(
      row => row.source === owner.source && row.project.id === owner.project.id
    )
    return snapshot
      ? { ...snapshot, loading: active && snapshot.revision !== revision }
      : {
          ...owner,
          issues: [],
          loading: active,
          error: null,
          revision,
        }
  })
}

export function useExperienceTasks(
  sources: ExperienceSource[],
  viewerIds: readonly (number | string)[],
  active: boolean,
  relevance: 'related' | 'all'
) {
  const [revision, setRevision] = useState(0)
  const catalog = useExperienceCatalog(sources, active, revision)
  const apis = useMemo(() => sources.map(source => source.api), [sources])
  const related = usePersonalHomeIssues(apis, active, false, true, viewerIds)
  const hydrated = useExperienceProjectHydration(
    sources,
    catalog,
    related.sourceSnapshots,
    active,
    revision + related.revision,
    JSON.stringify(viewerIds)
  )
  const completeCatalog = useMemo(
    () =>
      catalog.map(row => ({
        ...row,
        projects: [
          ...row.projects,
          ...hydrated
            .filter(candidate => candidate.source === row.source && candidate.project)
            .map(candidate => candidate.project!),
        ],
      })),
    [catalog, hydrated]
  )
  const all = useAllProjectIssues(completeCatalog, active && relevance === 'all', revision)
  const sharing = useExperienceSharing(
    sources,
    completeCatalog,
    related.sourceSnapshots,
    viewerIds,
    active,
    revision + related.revision
  )
  const projects: ExperienceProjectData[] = completeCatalog.flatMap(({ source, projects }) =>
    projects.map(project => ({
      project,
      participationViewer: source.participationViewer,
      collaborators: sharing
        .filter(row => row.source === source && (JSON.parse(row.key) as string[])[0] === project.id)
        .flatMap(row => row.value ?? []),
      issues: [
        ...(related.sourceSnapshots
          .find(row => row.api === source.api)
          ?.items.filter(issue => issue.cloud_project_id === project.id) ?? []),
        ...(relevance === 'all'
          ? (all.find(row => row.source === source && row.project.id === project.id)?.issues ?? [])
          : []),
      ],
    }))
  )
  const reloadRelated = related.reload
  const refresh = useCallback(() => {
    setRevision(value => value + 1)
    reloadRelated()
  }, [reloadRelated])
  const subscription = useExperienceTaskSubscriptions(sources, active, refresh)
  const retrySubscription = subscription.retry
  const reload = useCallback(() => {
    refresh()
    retrySubscription()
  }, [refresh, retrySubscription])
  useEffect(() => {
    if (!active || relevance !== 'all') return
    const context = subscribeProjectSpaceTaskContextChanged(reload)
    const bindings = subscribeProjectSpaceTaskBindingChanged(reload)
    window.addEventListener('focus', reload)
    return () => {
      context()
      bindings()
      window.removeEventListener('focus', reload)
    }
  }, [active, relevance, reload])
  const errors = [
    ...catalog.map(row => row.error),
    ...hydrated.map(row => row.error),
    ...sharing.map(row => row.error),
    ...(relevance === 'all' ? all.map(row => row.error) : []),
  ].filter(Boolean)
  return {
    projects,
    loading:
      catalog.some(row => row.loading) ||
      related.loading ||
      hydrated.some(row => row.loading) ||
      sharing.some(row => row.loading) ||
      (relevance === 'all' && all.some(row => row.loading)),
    errors,
    relatedError: related.error,
    hasMore: related.hasMore,
    loadMore: related.loadMore,
    reload,
    revision: revision + related.revision,
    subscriptionError: subscription.error,
  }
}
