import type { CollaborationProject } from '../types'
import { getClientRequestCache } from '@wegent/chat-core/request-cache'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { Milestone, MilestonesApi } from './types'

interface QueryScope {
  api: MilestonesApi | undefined
  projectId: string
  authScope: unknown
  visibilityScope: string
  refreshKey: string | undefined
}
interface QueryOwner extends QueryScope {
  resource: ReturnType<typeof createAsyncResource<Milestone[]>> | null
  invalidate(): void
}
function createQuery(scope: QueryScope, previous?: QueryOwner): QueryOwner {
  const { api, projectId, visibilityScope } = scope
  if (!api || !projectId) return { ...scope, resource: null, invalidate() {} }
  const cache = getClientRequestCache(api)
  const key = `milestones:${projectId}:${visibilityScope}`
  const sameScope =
    previous?.api === api &&
    previous.projectId === projectId &&
    previous.authScope === scope.authScope &&
    previous.visibilityScope === visibilityScope
  let invalidated = previous !== undefined && previous.refreshKey !== scope.refreshKey
  const resource = createAsyncResource<Milestone[]>(
    key,
    () => {
      if (invalidated) cache.invalidate(key)
      invalidated = false
      return cache.get(key, () => api.list(projectId), 0)
    },
    {
      refreshOnSubscribe: true,
      initialData: sameScope ? previous?.resource?.getSnapshot().data : undefined,
    }
  )
  return { ...scope, resource, invalidate: () => cache.invalidate(key) }
}

export function useMilestones(
  api: MilestonesApi | undefined,
  projectId: string,
  enabled = true,
  refreshKey?: string,
  visibilityScope = ''
) {
  const authScope = api?.getCacheScope?.()
  const [query, setQuery] = useState(() =>
    createQuery({ api, projectId, authScope, visibilityScope, refreshKey })
  )
  if (
    query.api !== api ||
    query.projectId !== projectId ||
    query.authScope !== authScope ||
    query.visibilityScope !== visibilityScope ||
    query.refreshKey !== refreshKey
  ) {
    setQuery(createQuery({ api, projectId, authScope, visibilityScope, refreshKey }, query))
  }
  const resource = query.resource
  const snapshot = useSyncExternalStore(
    enabled && resource ? resource.subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const observeSelection = useCallback(
    (
      listener: () => void,
      value: string | null | undefined,
      onMissingValue: (() => void) | undefined
    ) => {
      if (!enabled || !resource) return subscribeIdleResource()
      let active = true
      let reported: ReturnType<typeof resource.getSnapshot> | undefined
      const notify = () => {
        listener()
        const current = resource.getSnapshot()
        if (
          active &&
          query.api?.getCacheScope?.() === query.authScope &&
          current.status === 'ready' &&
          current.data !== undefined &&
          current !== reported &&
          value &&
          value !== 'all' &&
          !current.data.some(item => item.id === value)
        ) {
          reported = current
          onMissingValue?.()
        }
      }
      const stop = resource.subscribe(notify)
      notify()
      return () => {
        active = false
        stop()
      }
    },
    [enabled, resource, query]
  )
  const reload = useCallback(() => {
    query.invalidate()
    if (enabled) void resource?.reload()
  }, [query, resource, enabled])
  return {
    enabled: Boolean(enabled && resource),
    getSnapshot: resource?.getSnapshot ?? getIdleResourceSnapshot,
    observeSelection,
    items: snapshot.data ?? [],
    loading: Boolean(
      enabled && resource && (snapshot.status === 'idle' || snapshot.status === 'loading')
    ),
    error: snapshot.status === 'error',
    reload,
  }
}

export function milestoneVisibilityScope(
  project: Pick<
    CollaborationProject,
    'current_user_id' | 'access_role' | 'project_store' | 'default_issue_security'
  >
): string {
  return JSON.stringify([
    project.current_user_id,
    project.access_role,
    project.project_store,
    project.default_issue_security,
  ])
}
