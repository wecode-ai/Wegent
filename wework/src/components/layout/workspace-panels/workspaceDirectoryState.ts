import { isWorkspaceDirectoryCacheFresh } from '@/features/workbench/workspaceFileDirectoryCache'
import type { WorkspaceFileEntry, WorkspaceTreeResponse } from '@/types/workspace-files'
import { workspaceFileAncestorPaths } from './workspaceFileTreeModel'

export interface WorkspaceRevealInput {
  selectedPath: string | null
  visible: boolean
  refreshVersion: number
  errorMessage?: string
}

export type WorkspaceDirectoryLoader = (path: string) => Promise<WorkspaceTreeResponse>

interface DirectoryState {
  activeDirectoryPath: string
  entriesByPath: Record<string, WorkspaceFileEntry[]>
  expandedPaths: Set<string>
  loadingPaths: Set<string>
  error: string | null
  retryPath: string | null
}

/** Own directory data, cached reads, retries and the selected file's ancestor traversal. */
export function createWorkspaceDirectoryState(
  rootPath: string,
  readDirectory: WorkspaceDirectoryLoader | null,
  loadRoot: boolean
) {
  const listeners = new Set<() => void>()
  const loadedAt = new Map<string, number>()
  const latestRequests = new Map<string, number>()
  const pending = new Map<string, Promise<boolean | undefined>>()
  let snapshot: DirectoryState = {
    activeDirectoryPath: rootPath,
    entriesByPath: {},
    expandedPaths: new Set(),
    loadingPaths: new Set(),
    error: null,
    retryPath: null,
  }
  let input: WorkspaceRevealInput = { selectedPath: null, visible: false, refreshVersion: 0 }
  let lifetime = 0
  let active = false
  let sequence = 0
  let revealVersion = 0
  let revealKey = ''
  const publish = (patch: Partial<DirectoryState>) => {
    if (!listeners.size) return
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const expand = (path: string) => {
    if (!snapshot.expandedPaths.has(path))
      publish({ expandedPaths: new Set(snapshot.expandedPaths).add(path) })
  }
  // Cancellation stays distinct from a failed directory read.
  const loadDirectory = (path: string, forceRefresh = false): Promise<boolean | undefined> => {
    if (!listeners.size || !rootPath || !readDirectory) return Promise.resolve(undefined)
    if (!forceRefresh && isWorkspaceDirectoryCacheFresh(loadedAt.get(path))) {
      expand(path)
      return Promise.resolve(true)
    }
    if (!forceRefresh && pending.has(path)) return pending.get(path)!
    const owner = lifetime
    const requestId = ++sequence
    const isCurrent = () =>
      listeners.size > 0 && lifetime === owner && latestRequests.get(path) === requestId
    latestRequests.set(path, requestId)
    publish({
      loadingPaths: new Set(snapshot.loadingPaths).add(path),
      error: null,
      retryPath: null,
    })
    let read: ReturnType<WorkspaceDirectoryLoader>
    try {
      read = readDirectory(path)
    } catch (error) {
      read = Promise.reject(error)
    }
    const request = read
      .then(result => {
        if (!isCurrent()) return undefined
        const resolvedPath = result.path || path
        publish({ entriesByPath: { ...snapshot.entriesByPath, [resolvedPath]: result.entries } })
        loadedAt.set(resolvedPath, Date.now())
        expand(resolvedPath)
        publish({ retryPath: null })
        return true
      })
      .catch(error => {
        if (!isCurrent()) return undefined
        publish({
          error:
            error instanceof Error
              ? error.message
              : (input.errorMessage ?? 'Failed to load directory'),
          retryPath: path,
        })
        return false
      })
      .finally(() => {
        if (!isCurrent()) return
        pending.delete(path)
        const loadingPaths = new Set(snapshot.loadingPaths)
        loadingPaths.delete(path)
        publish({ loadingPaths })
      })
    pending.set(path, request)
    return request
  }
  const reveal = () => {
    const version = ++revealVersion
    const selectedPath = input.selectedPath
    if (!input.visible || !rootPath || !selectedPath) return
    void (async () => {
      for (const path of workspaceFileAncestorPaths(rootPath, selectedPath)) {
        if (!listeners.size || version !== revealVersion || !(await loadDirectory(path))) break
      }
    })()
  }
  const updateReveal = (next: WorkspaceRevealInput) => {
    input = next
    const key = JSON.stringify([next.selectedPath, next.visible, next.refreshVersion])
    if (key !== revealKey) {
      revealKey = key
      reveal()
    }
  }
  return {
    getSnapshot: () => snapshot,
    updateReveal,
    subscribe(listener: () => void, next: WorkspaceRevealInput) {
      listeners.add(listener)
      if (!active) {
        active = true
        const owner = ++lifetime
        queueMicrotask(() => {
          if (listeners.size && lifetime === owner && loadRoot && rootPath)
            void loadDirectory(rootPath)
        })
      }
      updateReveal(next)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          active = false
          lifetime += 1
          revealVersion += 1
          revealKey = ''
          latestRequests.clear()
          pending.clear()
          snapshot = { ...snapshot, loadingPaths: new Set() }
        })
      }
    },
    loadDirectory,
    openDirectory(path: string) {
      if (!listeners.size) return
      publish({ activeDirectoryPath: path, error: null, retryPath: null })
      void loadDirectory(path)
    },
    async refresh() {
      const loaded = await loadDirectory(snapshot.retryPath ?? snapshot.activeDirectoryPath, true)
      if (loaded) reveal()
    },
  }
}
