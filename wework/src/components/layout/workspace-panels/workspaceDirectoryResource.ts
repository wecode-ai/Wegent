import type { WorkspaceFileApi, WorkspaceFileEntry } from '@/types/workspace-files'

interface DirectorySnapshot {
  entries: Record<string, WorkspaceFileEntry[]>
  errors: Record<string, string>
  loading: number
}

export function createWorkspaceDirectoryResource(
  api: WorkspaceFileApi,
  deviceId: string,
  rootPath: string,
  directoryPath: string,
  initialDirectoryPath?: string | null
) {
  let snapshot: DirectorySnapshot = { entries: {}, errors: {}, loading: 0 }
  const listeners = new Set<() => void>()
  const requested = new Set<string>()
  const requests = new Map<string, object>()
  const publish = (change: Partial<DirectorySnapshot>) => {
    snapshot = { ...snapshot, ...change, loading: requests.size }
    listeners.forEach(listener => listener())
  }
  const load = async (path: string, retry = false) => {
    if (!listeners.size || (requested.has(path) && !retry)) return
    requested.add(path)
    const request = {}
    requests.set(path, request)
    const errors = { ...snapshot.errors }
    delete errors[path]
    publish({ errors })
    try {
      const result = await api.listWorkspaceEntries(deviceId, path, rootPath)
      if (requests.get(path) !== request || !listeners.size) return
      requests.delete(path)
      publish({ entries: { ...snapshot.entries, [path]: result.entries } })
    } catch (error) {
      if (requests.get(path) !== request || !listeners.size) return
      requests.delete(path)
      publish({
        errors: {
          ...snapshot.errors,
          [path]: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
  return {
    getSnapshot: () => snapshot,
    load,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        void load(directoryPath).then(() => {
          if (
            initialDirectoryPath &&
            snapshot.entries[directoryPath]?.some(
              entry => entry.isDirectory && entry.path === initialDirectoryPath
            )
          ) {
            void load(initialDirectoryPath)
          }
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        requests.forEach((_request, path) => requested.delete(path))
        requests.clear()
        snapshot = { ...snapshot, loading: 0 }
      }
    },
  }
}
