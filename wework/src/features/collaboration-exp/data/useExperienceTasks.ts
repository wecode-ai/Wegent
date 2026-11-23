import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import type { ExperienceProjectData } from '../model/types'
import type { ExperienceSource } from './useExperienceSources'
import {
  createExperienceTasksSource,
  type ExperienceTaskBindingMemory,
} from './experienceTasksSource'
import { useExperienceTaskSubscriptions } from './useExperienceTaskSubscriptions'
import { useExperienceSharing } from './useExperienceSharing'

export function useExperienceTasks(
  sources: ExperienceSource[],
  viewerIds: readonly (number | string)[],
  active: boolean,
  relevance: 'related' | 'all'
) {
  const scopeKey = JSON.stringify(viewerIds)
  const [consumed] = useState<ExperienceTaskBindingMemory>(() => new WeakMap())
  const [owner, setOwner] = useState(() => ({
    sources: [...sources],
    scopeKey,
    source: createExperienceTasksSource(sources, viewerIds, consumed),
  }))
  if (
    owner.scopeKey !== scopeKey ||
    owner.sources.length !== sources.length ||
    owner.sources.some((source, index) => source !== sources[index])
  ) {
    setOwner({
      sources: [...sources],
      scopeKey,
      source: createExperienceTasksSource(
        sources,
        viewerIds,
        consumed,
        owner.scopeKey === scopeKey ? owner.source.getSnapshot() : undefined
      ),
    })
  }
  const taskSource = owner.source
  const refresh = taskSource.reload
  const subscription = useExperienceTaskSubscriptions(sources, active, refresh)
  const retrySubscription = subscription.retry
  const subscribe = useCallback(
    (notify: () => void) => taskSource.subscribe(notify, relevance, retrySubscription),
    [taskSource, relevance, retrySubscription]
  )
  const snapshot = useSyncExternalStore(
    active ? subscribe : subscribeIdleResource,
    taskSource.getSnapshot,
    taskSource.getSnapshot
  )
  const catalog = useMemo(
    () => snapshot.catalog.map(row => ({ ...row, loading: active && row.loading })),
    [snapshot.catalog, active]
  )
  const hydrated = useMemo(
    () => snapshot.hydrated.map(row => ({ ...row, loading: active && row.loading })),
    [snapshot.hydrated, active]
  )
  const related = useMemo(
    () => snapshot.related.rows.map(row => ({ ...row, loading: active && row.loading })),
    [snapshot.related.rows, active]
  )
  const all = snapshot.all
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
  const sharing = useExperienceSharing(
    sources,
    completeCatalog,
    related,
    viewerIds,
    active,
    snapshot.revision
  )
  const projects: ExperienceProjectData[] = completeCatalog.flatMap(({ source, projects }) =>
    projects.map(project => ({
      project,
      participationViewer: source.participationViewer,
      collaborators: sharing
        .filter(row => row.source === source && (JSON.parse(row.key) as string[])[0] === project.id)
        .flatMap(row => row.value ?? []),
      issues: [
        ...(related
          .find(row => row.api === source.api)
          ?.items.filter(issue => issue.cloud_project_id === project.id) ?? []),
        ...(relevance === 'all'
          ? (all.find(row => row.source === source && row.project.id === project.id)?.issues ?? [])
          : []),
      ],
    }))
  )
  const reload = useCallback(() => {
    refresh()
    retrySubscription()
  }, [refresh, retrySubscription])
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
      related.some(row => row.loading) ||
      hydrated.some(row => row.loading) ||
      sharing.some(row => row.loading) ||
      (active && relevance === 'all' && all.some(row => row.loading)),
    errors,
    relatedError: related.some(row => row.error),
    hasMore: related.some(row => row.nextCursor !== null),
    loadMoreReady: active && related.some(row => row.nextCursor && !row.loading),
    loadMore: taskSource.loadMore,
    reload,
    revision: snapshot.revision,
    subscriptionError: subscription.error,
  }
}
