import { FileTree, type FileTreeVisibleRow } from '@pierre/trees'
import type { TreeItemData } from '@ui-sdk/react/tree'

export interface FileTreeData {
  directoryPaths: string[]
  items: TreeItemData[]
  rowsByPath: Map<string, FileTreeVisibleRow>
}

export function createFileTreeData(
  paths: readonly string[],
  query = '',
  compressFolders = true
): FileTreeData {
  const model = new FileTree({
    paths,
    flattenEmptyDirectories: compressFolders,
    initialExpansion: 'open',
    search: false,
  })
  try {
    const directoryPaths = model
      .getVisibleRows(0, model.getVisibleCount())
      .filter(row => row.kind === 'directory')
      .map(row => row.path)
    if (query.trim()) model.setSearch(query.trim())
    const rows = model.getVisibleRows(0, model.getVisibleCount())
    const items: TreeItemData[] = []
    const itemsByPath = new Map<string, TreeItemData>()
    const rowsByPath = new Map<string, FileTreeVisibleRow>()
    for (const row of rows) {
      const item: TreeItemData = {
        value: row.path,
        label: row.flattenedSegments?.map(segment => segment.name).join('/') ?? row.name,
        ...(row.kind === 'directory' ? { children: [] } : {}),
      }
      itemsByPath.set(row.path, item)
      rowsByPath.set(row.path, row)
      const parent = itemsByPath.get(row.ancestorPaths.at(-1) ?? '')
      if (parent?.children) parent.children.push(item)
      else items.push(item)
    }
    return { items, rowsByPath, directoryPaths }
  } finally {
    model.cleanUp()
  }
}

export function resolveFileTreePath(
  data: FileTreeData,
  path: string | null | undefined
): string | null {
  if (!path) return null
  if (data.rowsByPath.has(path)) return path
  if (data.rowsByPath.has(`${path.replace(/\/$/, '')}/`)) return `${path.replace(/\/$/, '')}/`
  return (
    Array.from(data.rowsByPath.values()).find(row =>
      row.flattenedSegments?.some(
        segment => segment.path.replace(/\/$/, '') === path.replace(/\/$/, '')
      )
    )?.path ?? null
  )
}
