import type { WorkspaceFileEntry } from '@/types/workspace-files'

export interface WorkspaceTreeModel {
  paths: string[]
  entryByTreePath: Map<string, WorkspaceFileEntry>
  selectedTreePath: string | null
  expandedTreePaths: string[]
}

function normalizeWorkspacePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function relativeWorkspacePath(rootPath: string, path: string) {
  const root = normalizeWorkspacePath(rootPath)
  const target = normalizeWorkspacePath(path)
  const windowsPath = /^[a-z]:\//i.test(root) || root.startsWith('//')
  const comparableRoot = windowsPath ? root.toLowerCase() : root
  const comparableTarget = windowsPath ? target.toLowerCase() : target

  if (!root || comparableTarget === comparableRoot) return ''
  if (comparableTarget.startsWith(`${comparableRoot}/`)) return target.slice(root.length + 1)
  return target.replace(/^\/+/, '')
}

function treePathForEntry(rootPath: string, entry: WorkspaceFileEntry) {
  const relativePath = relativeWorkspacePath(rootPath, entry.path) || entry.name
  return entry.isDirectory ? `${relativePath.replace(/\/+$/, '')}/` : relativePath
}

function lookupTreePathCandidates(path: string) {
  const normalizedPath = path.replace(/\/+$/, '')
  return [path, normalizedPath, `${normalizedPath}/`]
}

export function createWorkspaceTreeModel({
  activeDirectoryPath,
  entriesByPath,
  expandedPaths,
  rootPath,
  selectedPath,
}: {
  activeDirectoryPath: string
  entriesByPath: Record<string, WorkspaceFileEntry[]>
  expandedPaths: Set<string>
  rootPath: string
  selectedPath?: string | null
}): WorkspaceTreeModel {
  const entriesByCanonicalTreePath = new Map<string, WorkspaceFileEntry>()
  const entryByTreePath = new Map<string, WorkspaceFileEntry>()

  Object.values(entriesByPath).forEach(entries => {
    entries.forEach(entry => {
      const canonicalTreePath = treePathForEntry(rootPath, entry).replace(/\/+$/, '')
      const previousEntry = entriesByCanonicalTreePath.get(canonicalTreePath)
      if (!previousEntry || entry.isDirectory) {
        entriesByCanonicalTreePath.set(canonicalTreePath, entry)
      }
    })
  })

  const treePaths = Array.from(entriesByCanonicalTreePath.entries())
    .map(([treePath, entry]) => {
      entryByTreePath.set(treePath, entry)
      if (!entry.isDirectory) return treePath

      const directoryPath = `${treePath}/`
      entryByTreePath.set(directoryPath, entry)
      return directoryPath
    })
    .sort((left, right) => left.localeCompare(right))

  const expandedTreePaths = Array.from(expandedPaths)
    .map(path => {
      const relativePath = relativeWorkspacePath(rootPath, path)
      return relativePath ? `${relativePath.replace(/\/+$/, '')}/` : null
    })
    .filter((path): path is string => Boolean(path))

  const activeTreePath = relativeWorkspacePath(rootPath, activeDirectoryPath)
  const selectedTreePath = selectedPath
    ? relativeWorkspacePath(rootPath, selectedPath)
    : activeTreePath
      ? `${activeTreePath.replace(/\/+$/, '')}/`
      : null

  return {
    paths: treePaths,
    entryByTreePath,
    selectedTreePath,
    expandedTreePaths,
  }
}

export function getEntryByTreePath(
  entries: Map<string, WorkspaceFileEntry>,
  treePath: string
): WorkspaceFileEntry | null {
  for (const candidate of lookupTreePathCandidates(treePath)) {
    const entry = entries.get(candidate)
    if (entry) return entry
  }
  return null
}
