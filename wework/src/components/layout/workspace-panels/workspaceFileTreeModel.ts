import type { WorkspaceFileEntry } from '@/types/workspace-files'

export interface WorkspaceTreeModel {
  paths: string[]
  entryByTreePath: Map<string, WorkspaceFileEntry>
  caseInsensitivePaths: boolean
  selectedTreePath: string | null
  expandedTreePaths: string[]
}

function normalizeWorkspacePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isWindowsWorkspacePath(path: string) {
  const normalizedPath = normalizeWorkspacePath(path)
  return /^[a-z]:(?:\/|$)/i.test(normalizedPath) || normalizedPath.startsWith('//')
}

function relativeWorkspacePath(rootPath: string, path: string) {
  const root = normalizeWorkspacePath(rootPath)
  const target = normalizeWorkspacePath(path)
  const windowsPath = isWindowsWorkspacePath(root)
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

function treePathKey(path: string, caseInsensitivePaths: boolean) {
  const normalizedPath = path.replace(/\/+$/, '')
  return caseInsensitivePaths ? normalizedPath.toLowerCase() : normalizedPath
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
  const caseInsensitivePaths = isWindowsWorkspacePath(rootPath)
  const entriesByCanonicalTreePath = new Map<
    string,
    { entry: WorkspaceFileEntry; relativePath: string }
  >()
  const directoryNameByTreePath = new Map<string, string>()
  const entryByTreePath = new Map<string, WorkspaceFileEntry>()

  Object.values(entriesByPath).forEach(entries => {
    entries.forEach(entry => {
      const relativePath = treePathForEntry(rootPath, entry).replace(/\/+$/, '')
      const canonicalTreePath = treePathKey(relativePath, caseInsensitivePaths)
      const previousRecord = entriesByCanonicalTreePath.get(canonicalTreePath)
      if (!previousRecord || entry.isDirectory) {
        entriesByCanonicalTreePath.set(canonicalTreePath, { entry, relativePath })
      }
      if (entry.isDirectory) {
        directoryNameByTreePath.set(canonicalTreePath, entry.name)
      }
    })
  })

  const displayTreePath = (canonicalTreePath: string, relativePath: string) => {
    const canonicalSegments = canonicalTreePath.split('/')
    const relativeSegments = relativePath.split('/')
    return canonicalSegments
      .map((_, index) => {
        const directoryKey = canonicalSegments.slice(0, index + 1).join('/')
        return directoryNameByTreePath.get(directoryKey) ?? relativeSegments[index]
      })
      .join('/')
  }
  const displayTreePathByKey = new Map<string, string>()
  const treePaths = Array.from(entriesByCanonicalTreePath.entries())
    .map(([canonicalTreePath, { entry, relativePath }]) => {
      const treePath = displayTreePath(canonicalTreePath, relativePath)
      displayTreePathByKey.set(canonicalTreePath, treePath)
      entryByTreePath.set(canonicalTreePath, entry)
      if (!entry.isDirectory) return treePath

      const directoryPath = `${treePath}/`
      return directoryPath
    })
    .sort((left, right) => left.localeCompare(right))

  const expandedTreePaths = Array.from(expandedPaths)
    .map(path => {
      const relativePath = relativeWorkspacePath(rootPath, path)
      if (!relativePath) return null
      const canonicalTreePath = treePathKey(relativePath, caseInsensitivePaths)
      const treePath = displayTreePathByKey.get(canonicalTreePath) ?? relativePath
      return `${treePath.replace(/\/+$/, '')}/`
    })
    .filter((path): path is string => Boolean(path))

  const activeTreePath = relativeWorkspacePath(rootPath, activeDirectoryPath)
  const selectedRelativePath = selectedPath
    ? relativeWorkspacePath(rootPath, selectedPath)
    : activeTreePath
  const selectedDisplayPath = selectedRelativePath
    ? (displayTreePathByKey.get(treePathKey(selectedRelativePath, caseInsensitivePaths)) ??
      selectedRelativePath)
    : null
  const selectedTreePath =
    selectedDisplayPath && !selectedPath
      ? `${selectedDisplayPath.replace(/\/+$/, '')}/`
      : selectedDisplayPath

  return {
    paths: treePaths,
    entryByTreePath,
    caseInsensitivePaths,
    selectedTreePath,
    expandedTreePaths,
  }
}

export function getEntryByTreePath(
  entries: Map<string, WorkspaceFileEntry>,
  treePath: string,
  caseInsensitivePaths = false
): WorkspaceFileEntry | null {
  for (const candidate of lookupTreePathCandidates(treePath)) {
    const entry = entries.get(treePathKey(candidate, caseInsensitivePaths))
    if (entry) return entry
  }
  return null
}
