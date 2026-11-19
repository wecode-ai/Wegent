import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'

const EMPTY_PROJECTS: CloudProject[] = []

function createProjectsStore(
  apis: ProjectSpaceApi[],
  initial = new Map<ProjectSpaceApi, CloudProject[]>()
) {
  const resources = new Map(
    apis.map(api => [
      api,
      createAsyncResource(
        'project-space-projects',
        () => api.listCloudProjects().then(result => result.items),
        { initialData: initial.get(api) ?? EMPTY_PROJECTS }
      ),
    ])
  )
  let snapshot = new Map(apis.map(api => [api, initial.get(api) ?? EMPTY_PROJECTS]))
  const listeners = new Set<() => void>()
  let disconnect: Array<() => void> = []
  const publish = () => {
    const next = new Map(
      [...resources].map(([api, resource]) => [
        api,
        resource.getSnapshot().status === 'error'
          ? EMPTY_PROJECTS
          : (resource.getSnapshot().data ?? EMPTY_PROJECTS),
      ])
    )
    if ([...next].every(([api, items]) => snapshot.get(api) === items)) return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  return {
    apis,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1)
        disconnect = [...resources.values()].map(resource => {
          const stop = resource.subscribe(publish)
          if (resource.getSnapshot().status === 'ready') void resource.reload()
          return stop
        })
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          disconnect.forEach(stop => stop())
          disconnect = []
        }
      }
    },
  }
}
const noSubscription = () => () => {}

export function useProjectSpaceProjects(active: boolean, apis: ProjectSpaceApi[], scope?: unknown) {
  const owners = [...new Set(apis)]
  const [owner, setOwner] = useState(() => ({ scope, store: createProjectsStore(owners) }))
  const store = owner.store
  if (!Object.is(owner.scope, scope)) setOwner({ scope, store: createProjectsStore(owners) })
  else if (store.apis.length !== owners.length || owners.some(api => !store.apis.includes(api)))
    setOwner({ scope, store: createProjectsStore(owners, store.getSnapshot()) })
  const subscribe = useCallback(
    (listener: () => void) => (active ? store.subscribe(listener) : noSubscription()),
    [active, store]
  )
  const projectsByApi = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
  return useMemo(() => {
    const projects = apis.flatMap(api => projectsByApi.get(api) ?? [])
    return projects.filter(
      (project, index) =>
        projects.findIndex(
          other => other.id === project.id && other.project_store === project.project_store
        ) === index
    )
  }, [apis, projectsByApi])
}
