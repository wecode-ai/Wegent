import { createAsyncResource } from '@wegent/chat-core/async-resource'
import {
  canStartWorkOnCollaborationIssue,
  type CollaborationProject,
  type WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import type { RuntimeProjectSpaceRef, RuntimeTaskAddress } from '@/types/api'
import { createPersonalHomeIssuesSource } from '@/features/todo/personalHomeIssuesSource'
import {
  projectSpaceForRuntimeTask,
  rememberProjectSpaceTaskBinding,
  sameProjectSpace,
} from '@/features/todo/projectSpaceSelection'
import type { ExperienceProjectData } from '../model/types'
import type { ExperienceSource } from './useExperienceSources'
import { invalidatesExperienceRead } from './useExperienceSourceReads'

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

interface VerifiedBinding {
  task: RuntimeTaskAddress
  project: RuntimeProjectSpaceRef
  fresh: boolean
}

function rememberVerifiedBindings(bindings: VerifiedBinding[]) {
  const groups = new Map<string, VerifiedBinding[]>()
  for (const binding of bindings) {
    const key = JSON.stringify([binding.task.deviceId, binding.task.taskId])
    groups.set(key, [...(groups.get(key) ?? []), binding])
  }
  for (const candidates of groups.values()) {
    const current = projectSpaceForRuntimeTask(candidates[0].task)
    const userProjects = candidates.filter(
      row => row.project.projectId !== DEFAULT_WORK_ITEM_PROJECT_ID
    )
    const preferred =
      userProjects.find(row => sameProjectSpace(current, row.project)) ?? userProjects[0]
    const selected =
      preferred ??
      (current?.projectId !== DEFAULT_WORK_ITEM_PROJECT_ID && current
        ? undefined
        : (candidates.find(row => sameProjectSpace(current, row.project)) ?? candidates[0]))
    if (selected?.fresh) rememberProjectSpaceTaskBinding(selected.task, selected.project)
  }
}

interface Read<T> {
  resource: ReturnType<typeof createAsyncResource<T>>
  stop?: () => void
  version: number
}
interface HydratedProject {
  source: ExperienceSource
  id: string
  project: CollaborationProject | null
  loading: boolean
  error: string | null
}
const errorText = (cause: unknown) =>
  cause === undefined ? null : cause instanceof Error ? cause.message : String(cause)
const makeRead = <T>(key: string, load: () => Promise<T>, initialData?: T): Read<T> => ({
  resource: createAsyncResource(key, load, { refreshOnSubscribe: true, initialData }),
  version: -1,
})

export type ExperienceTaskBindingMemory = WeakMap<
  ExperienceSource,
  WeakMap<WorkspaceMyWorkItem, string>
>
interface ExperienceTasksSnapshot {
  catalog: CatalogSnapshot[]
  hydrated: HydratedProject[]
  related: ReturnType<ReturnType<typeof createPersonalHomeIssuesSource>['getSnapshot']>
  all: AllIssuesSnapshot[]
  revision: number
}

/** Verified bindings are published only alongside current authoritative task data. */
export function createExperienceTasksSource(
  sources: ExperienceSource[],
  viewerIds: readonly (number | string)[],
  consumed: ExperienceTaskBindingMemory,
  initial?: ExperienceTasksSnapshot
) {
  const personal = createPersonalHomeIssuesSource(
    sources.map(source => source.api),
    {
      scope: 'participating',
      includeCompleted: true,
      viewerIds: [...viewerIds],
      order: 'attention',
    },
    initial?.related
  )
  const catalogs = new Map(
    sources.map(source => [
      source,
      makeRead(
        'experience-catalog',
        () => source.api.projects.list(),
        initial?.catalog.find(row => row.source === source)?.projects
      ),
    ])
  )
  const hydration = new Map<ExperienceSource, Map<string, Read<CollaborationProject>>>()
  const issues = new Map<ExperienceSource, Map<string, Read<ExperienceProjectData['issues']>>>()
  const observers = new Set<{ notify(): void; relevance: 'related' | 'all'; retry(): void }>()
  let personalStop: (() => void) | undefined
  let revision = initial ? initial.revision - initial.related.revision : 0
  let relatedRevision = personal.getSnapshot().revision
  let refreshing = false
  let reconciling = false
  let queued = false
  const allActive = () => [...observers].at(-1)?.relevance === 'all'
  const version = () => revision + personal.getSnapshot().revision
  const catalogSnapshot = (): CatalogSnapshot[] =>
    sources.map(source => {
      const read = catalogs.get(source)!.resource.getSnapshot()
      return {
        source,
        projects: read.data ?? [],
        loading: read.status === 'idle' || read.status === 'loading',
        error: errorText(read.error),
        revision,
      }
    })
  const missing = (source: ExperienceSource) => {
    const known = new Set(
      catalogs
        .get(source)!
        .resource.getSnapshot()
        .data?.map(project => project.id)
    )
    return [
      ...new Set(
        personal
          .getSnapshot()
          .rows.find(row => row.api === source.api)
          ?.items.map(issue => issue.cloud_project_id)
          .filter(id => id && !known.has(id)) ?? []
      ),
    ]
  }
  const hydratedSnapshot = (): HydratedProject[] =>
    sources.flatMap(source =>
      missing(source).map(id => {
        const read = hydration.get(source)?.get(id)?.resource.getSnapshot()
        return {
          source,
          id,
          project: read && !invalidatesExperienceRead(read.error) ? (read.data ?? null) : null,
          loading: !read || read.status === 'idle' || read.status === 'loading',
          error: errorText(read?.error),
        }
      })
    )
  const completeCatalog = () => {
    const hydrated = hydratedSnapshot()
    return catalogSnapshot().map(row => ({
      ...row,
      projects: [
        ...row.projects,
        ...hydrated
          .filter(candidate => candidate.source === row.source && candidate.project)
          .map(candidate => candidate.project!),
      ],
    }))
  }
  const allIssuesSnapshot = (): AllIssuesSnapshot[] =>
    completeCatalog().flatMap(row =>
      row.projects.map(project => {
        const read = issues.get(row.source)?.get(project.id)?.resource.getSnapshot()
        return {
          source: row.source,
          project,
          issues: read?.data ?? [],
          loading: !read || read.status === 'idle' || read.status === 'loading',
          error: errorText(read?.error),
          revision,
        }
      })
    )
  const readSnapshot = (): ExperienceTasksSnapshot => ({
    catalog: catalogSnapshot(),
    hydrated: hydratedSnapshot(),
    related: personal.getSnapshot(),
    all: allIssuesSnapshot(),
    revision: version(),
  })
  let snapshot = readSnapshot()

  const remember = () => {
    const bindings: VerifiedBinding[] = []
    const projects = [
      ...snapshot.catalog.flatMap(row =>
        row.loading || row.error
          ? []
          : row.projects.map(project => ({ source: row.source, project }))
      ),
      ...snapshot.hydrated.flatMap(row =>
        !row.loading && !row.error && row.project
          ? [{ source: row.source, project: row.project }]
          : []
      ),
    ]
    for (const source of sources) {
      const row = snapshot.related.rows.find(row => row.api === source.api)
      if (!row || row.loading || row.error) continue
      const seen = consumed.get(source) ?? new WeakMap<WorkspaceMyWorkItem, string>()
      consumed.set(source, seen)
      for (const issue of row.items) {
        const owner = projects.find(
          project => project.source === source && project.project.id === issue.cloud_project_id
        )
        if (
          !owner ||
          owner.project.project_store !== source.store ||
          !issue.task_bindings ||
          !canStartWorkOnCollaborationIssue(issue)
        )
          continue
        const fresh = seen.get(issue) !== row.queryKey
        seen.set(issue, row.queryKey)
        for (const binding of issue.task_bindings) {
          if (
            binding.projectId !== owner.project.id ||
            binding.issueId !== issue.id ||
            !binding.deviceId ||
            !binding.taskId
          )
            continue
          bindings.push({
            fresh,
            task: { deviceId: binding.deviceId, taskId: binding.taskId },
            project: { projectStore: source.store, projectId: owner.project.id },
          })
        }
      }
    }
    rememberVerifiedBindings(bindings)
  }
  const observeRead = <T>(read: Read<T>, requested: number) => {
    if (!read.stop) {
      read.version = requested
      read.stop = read.resource.subscribe(publish, requested)
    } else if (read.version !== requested) {
      read.version = requested
      void read.resource.reload()
    }
  }
  const ensureReads = () => {
    for (const source of sources) {
      let entries = hydration.get(source)
      if (!entries) {
        entries = new Map()
        hydration.set(source, entries)
      }
      const required = new Set(missing(source))
      for (const [id, entry] of entries)
        if (!required.has(id)) {
          entry.stop?.()
          entry.stop = undefined
        }
      for (const id of required) {
        let read = entries.get(id)
        if (!read) {
          read = makeRead(
            id,
            async () => {
              const project = await source.api.projects.get(id)
              if (project.id !== id || project.project_store !== source.store)
                throw Object.assign(new Error('Project source does not match My work'), {
                  code: 'source_mismatch',
                })
              return project
            },
            initial?.hydrated.find(row => row.source === source && row.id === id)?.project ??
              undefined
          )
          entries.set(id, read)
        }
        observeRead(read, version())
      }
    }
    if (!allActive()) return
    for (const { source, projects } of completeCatalog()) {
      let entries = issues.get(source)
      if (!entries) {
        entries = new Map()
        issues.set(source, entries)
      }
      const required = new Set(projects.map(project => project.id))
      for (const [id, read] of entries)
        if (!required.has(id)) {
          read.stop?.()
          read.stop = undefined
        }
      for (const project of projects) {
        let read = entries.get(project.id)
        if (!read) {
          read = makeRead<ExperienceProjectData['issues']>(
            project.id,
            () => source.api.issues.list(project.id),
            initial?.all.find(row => row.source === source && row.project.id === project.id)?.issues
          )
          entries.set(project.id, read)
        }
        observeRead(read, version())
      }
    }
  }
  function publish() {
    if (!observers.size) return
    if (reconciling) {
      queued = true
      return
    }
    reconciling = true
    do {
      queued = false
      ensureReads()
      snapshot = readSnapshot()
      remember()
      observers.forEach(observer => observer.notify())
    } while (queued)
    reconciling = false
  }
  const refreshCatalog = () => {
    for (const read of catalogs.values()) observeRead(read, version())
  }
  const onPersonalChanged = () => {
    const current = personal.getSnapshot().revision
    if (current !== relatedRevision) {
      relatedRevision = current
      if (allActive() && !refreshing) {
        refreshCatalog()
        Array.from(observers).at(-1)?.retry()
      }
    }
    publish()
  }
  const stopReads = () => {
    for (const read of catalogs.values()) {
      read.stop?.()
      read.stop = undefined
    }
    for (const entries of [...hydration.values(), ...issues.values()])
      for (const read of entries.values()) {
        read.stop?.()
        read.stop = undefined
      }
    personalStop?.()
    personalStop = undefined
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void, relevance: 'related' | 'all', retry: () => void) {
      const observer = { notify, relevance, retry }
      observers.add(observer)
      if (!personalStop) {
        refreshCatalog()
        personalStop = personal.subscribe(onPersonalChanged)
      }
      if (!allActive())
        for (const entries of issues.values())
          for (const read of entries.values()) {
            read.stop?.()
            read.stop = undefined
          }
      publish()
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (!observers.size) stopReads()
        })
      }
    },
    reload() {
      if (!observers.size) return
      revision++
      refreshing = true
      personal.reload()
      refreshing = false
      refreshCatalog()
      publish()
    },
    loadMore: personal.loadMore,
  }
}
