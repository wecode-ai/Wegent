import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type {
  WorkspaceGitBranch,
  WorkspaceGitRepository,
  SharedWorkspaceApi,
} from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironmentRepository } from '../types'
import { repositoryKey } from './environmentConfiguration'

export type RepositoryDraft = CollaborationExecutionEnvironmentRepository & { id: string }
export type RepositoryDefaults = Map<string, { name: string; path: string; ref: string }>
export type RepositoryBranchState = Record<
  string,
  { status: 'loading' | 'ready' | 'error'; branches: WorkspaceGitBranch[] }
>

/** Branch reads belong to the repositories currently observed by this editor. */
export function createEnvironmentRepositoryBranches(
  api: SharedWorkspaceApi['gitRepositories'],
  updateDrafts: (change: (drafts: RepositoryDraft[]) => RepositoryDraft[]) => void,
  defaults: RepositoryDefaults
) {
  const queries = new Map<string, ReturnType<typeof createAsyncResource<WorkspaceGitBranch[]>>>()
  const get = (option: WorkspaceGitRepository) => {
    const key = repositoryKey(option)
    let query = queries.get(key)
    if (!query) {
      query = createAsyncResource(key, () => api!.listBranches(option), {
        success(branches) {
          const preferred = branches.find(branch => branch.default) ?? branches[0]
          if (!preferred) return
          updateDrafts(current =>
            current.map(draft => {
              if (draft.url !== option.cloneUrl) return draft
              const derived = defaults.get(draft.id)
              if (draft.ref && draft.ref !== derived?.ref) return draft
              defaults.set(draft.id, {
                name: derived?.name ?? '',
                path: derived?.path ?? '',
                ref: preferred.name,
              })
              return { ...draft, ref: preferred.name }
            })
          )
        },
      })
      queries.set(key, query)
    }
    return query
  }
  return {
    observe(options: WorkspaceGitRepository[]) {
      const sources = api
        ? [...new Map(options.map(option => [repositoryKey(option), get(option)])).entries()]
        : []
      const read = (): RepositoryBranchState =>
        Object.fromEntries(
          sources.map(([key, source]) => {
            const snapshot = source.getSnapshot()
            return [
              key,
              {
                status:
                  snapshot.status === 'error'
                    ? 'error'
                    : snapshot.status === 'ready'
                      ? 'ready'
                      : 'loading',
                branches: snapshot.status === 'error' ? [] : (snapshot.data ?? []),
              },
            ]
          })
        )
      let snapshot = read()
      const listeners = new Set<() => void>()
      let stops: (() => void)[] = []
      const publish = () => {
        snapshot = read()
        listeners.forEach(listener => listener())
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener)
          if (listeners.size === 1) {
            stops = sources.map(([, query]) => query.subscribe(publish))
            publish()
          }
          return () => {
            listeners.delete(listener)
            if (!listeners.size) {
              stops.forEach(stop => stop())
              stops = []
            }
          }
        },
      }
    },
    retry(option: WorkspaceGitRepository) {
      if (!api) return Promise.resolve()
      const query = get(option)
      return query.getSnapshot().status === 'loading' ? Promise.resolve() : query.reload()
    },
  }
}
