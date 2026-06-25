import { FileTree, useFileTree } from '@pierre/trees/react'
import { RefreshCw, Search } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkspaceFileEntry } from '@/types/workspace-files'

const PIERRE_WORKSPACE_FILE_TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-bg-muted-override: rgb(247 247 248);
    --trees-fg-override: rgb(102 102 102);
    --trees-fg-muted-override: rgb(140 140 140);
    --trees-border-color-override: rgb(224 224 224);
    --trees-selected-bg-override: rgb(247 247 248);
    --trees-selected-fg-override: rgb(26 26 26);
    --trees-selected-focused-border-color-override: rgb(20 184 166);
    --trees-focus-ring-color-override: rgb(20 184 166 / 0.35);
    --trees-focus-ring-width-override: 1px;
    --trees-focus-ring-offset-override: 0px;
    --trees-gap-override: 2px;
    --trees-level-gap-override: 6px;
    --trees-item-padding-x-override: 4px;
    --trees-item-margin-x-override: 0px;
    --trees-padding-inline-override: 4px;
    --trees-indent-guide-bg-override: rgb(224 224 224);
    --trees-scrollbar-thumb-override: rgb(224 224 224 / 0.55);
    --trees-file-icon-color: rgb(140 140 140);
    --trees-file-icon-color-default: rgb(140 140 140);
    --trees-icon-blue: rgb(140 140 140);
    --trees-icon-cyan: rgb(140 140 140);
    --trees-icon-green: rgb(140 140 140);
    --trees-icon-indigo: rgb(140 140 140);
    --trees-icon-mauve: rgb(140 140 140);
    --trees-icon-orange: rgb(140 140 140);
    --trees-icon-pink: rgb(140 140 140);
    --trees-icon-purple: rgb(140 140 140);
    --trees-icon-red: rgb(140 140 140);
    --trees-icon-teal: rgb(140 140 140);
    --trees-icon-vermilion: rgb(140 140 140);
    --trees-icon-yellow: rgb(140 140 140);
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    font-size: 13px;
    color: rgb(102 102 102);
    background: transparent !important;
  }
  button[data-type='item'] {
    box-sizing: border-box;
    border-radius: 6px;
    color: rgb(102 102 102);
    background: transparent;
    background-clip: padding-box;
  }
  button[data-type='item']:hover {
    color: rgb(26 26 26);
    background: rgb(247 247 248);
    box-shadow:
      0 0 0 1px rgb(255 255 255),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected] {
    color: rgb(26 26 26);
    background: rgb(247 247 248) !important;
    box-shadow:
      0 0 0 1px rgb(255 255 255),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected='true']:has(+ [data-item-selected='true']),
  button[data-type='item'][data-item-selected='true'] + [data-item-selected='true'] {
    border-radius: 6px !important;
  }
  button[data-type='item'][data-item-focused='true']::before,
  button[data-type='item']:focus-visible::before {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--trees-focus-ring-color);
  }
  button[data-type='item'][data-item-focused='true'][data-item-selected='true']::before,
  button[data-type='item'][data-item-selected='true']:focus-visible::before {
    box-shadow: inset 0 0 0 1px var(--trees-selected-focused-border-color);
  }
`

interface WorkspaceFileTreeProps {
  rootPath: string
  activeDirectoryPath: string
  entriesByPath: Record<string, WorkspaceFileEntry[]>
  expandedPaths: Set<string>
  selectedPath?: string | null
  loadingPaths: Set<string>
  error?: string | null
  onOpenDirectory: (entry: WorkspaceFileEntry) => void
  onOpenFile: (entry: WorkspaceFileEntry) => void
  onRefresh: () => void
}

interface WorkspaceTreeModel {
  paths: string[]
  entryByTreePath: Map<string, WorkspaceFileEntry>
  selectedTreePath: string | null
  expandedTreePaths: string[]
}

function sortEntries(entries: WorkspaceFileEntry[]) {
  return [...entries].sort((first, second) => {
    if (first.isDirectory !== second.isDirectory) {
      return first.isDirectory ? -1 : 1
    }
    return first.name.localeCompare(second.name)
  })
}

function normalizeWorkspacePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function relativeWorkspacePath(rootPath: string, path: string) {
  const root = normalizeWorkspacePath(rootPath)
  const target = normalizeWorkspacePath(path)

  if (!root || target === root) return ''
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1)
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

function createWorkspaceTreeModel({
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
  const treePaths = new Set<string>()
  const entryByTreePath = new Map<string, WorkspaceFileEntry>()

  Object.values(entriesByPath).forEach(entries => {
    sortEntries(entries).forEach(entry => {
      const treePath = treePathForEntry(rootPath, entry)
      treePaths.add(treePath)
      entryByTreePath.set(treePath, entry)
      if (entry.isDirectory) {
        entryByTreePath.set(treePath.replace(/\/+$/, ''), entry)
      }
    })
  })

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
    paths: Array.from(treePaths),
    entryByTreePath,
    selectedTreePath,
    expandedTreePaths,
  }
}

function getEntryByTreePath(entries: Map<string, WorkspaceFileEntry>, treePath: string) {
  for (const candidate of lookupTreePathCandidates(treePath)) {
    const entry = entries.get(candidate)
    if (entry) return entry
  }
  return null
}

function WorkspacePierreFileTree({
  modelKey,
  treeModel,
  query,
  onOpenDirectory,
  onOpenFile,
}: {
  modelKey: string
  treeModel: WorkspaceTreeModel
  query: string
  onOpenDirectory: (entry: WorkspaceFileEntry) => void
  onOpenFile: (entry: WorkspaceFileEntry) => void
}) {
  const { model } = useFileTree({
    density: 'compact',
    flattenEmptyDirectories: true,
    icons: { set: 'complete', colored: false },
    initialExpandedPaths: treeModel.expandedTreePaths,
    initialSelectedPaths: treeModel.selectedTreePath ? [treeModel.selectedTreePath] : [],
    itemHeight: 28,
    onSelectionChange: selectedPaths => {
      const nextPath = selectedPaths[0]
      if (!nextPath) return

      const entry = getEntryByTreePath(treeModel.entryByTreePath, nextPath)
      if (!entry) return

      if (entry.isDirectory) {
        model.getItem(nextPath)?.expand()
        onOpenDirectory(entry)
      } else {
        onOpenFile(entry)
      }
    },
    paths: treeModel.paths,
    search: false,
    unsafeCSS: PIERRE_WORKSPACE_FILE_TREE_CSS,
  })

  useEffect(() => {
    model.setSearch(query.trim() || null)
  }, [model, query])

  useEffect(() => {
    if (!treeModel.selectedTreePath) return
    model.getItem(treeModel.selectedTreePath)?.select()
    model.scrollToPath(treeModel.selectedTreePath, { focus: false, offset: 'nearest' })
  }, [model, treeModel.selectedTreePath])

  useEffect(() => {
    treeModel.expandedTreePaths.forEach(path => model.getItem(path)?.expand())
  }, [model, treeModel.expandedTreePaths])

  return (
    <FileTree
      key={modelKey}
      data-testid="workspace-file-tree-pierre"
      model={model}
      className="block h-full min-h-0 w-full"
      style={
        {
          '--trees-border-color-override': 'rgb(var(--color-border))',
          '--trees-fg-override': 'rgb(var(--color-text-secondary))',
          '--trees-selected-bg-override': 'rgb(var(--color-bg-surface))',
        } as CSSProperties
      }
    />
  )
}

export function WorkspaceFileTree({
  rootPath,
  activeDirectoryPath,
  entriesByPath,
  expandedPaths,
  selectedPath,
  loadingPaths,
  error,
  onOpenDirectory,
  onOpenFile,
  onRefresh,
}: WorkspaceFileTreeProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const treeModel = useMemo(
    () =>
      createWorkspaceTreeModel({
        activeDirectoryPath,
        entriesByPath,
        expandedPaths,
        rootPath,
        selectedPath,
      }),
    [activeDirectoryPath, entriesByPath, expandedPaths, rootPath, selectedPath]
  )
  const loadingRoot = loadingPaths.has(rootPath)
  const modelKey = useMemo(
    () => `${treeModel.paths.join('\n')}::${treeModel.expandedTreePaths.join('\n')}`,
    [treeModel.expandedTreePaths, treeModel.paths]
  )

  return (
    <aside
      data-testid="workspace-file-tree"
      className="flex h-full min-h-0 w-[240px] shrink-0 flex-col border-l border-border bg-background"
    >
      <div className="px-3 pb-1.5 pt-2">
        <div className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            data-testid="workspace-file-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('workbench.workspace_file_search', '筛选文件...')}
            aria-label={t('workbench.workspace_file_search', '筛选文件...')}
            className="min-w-0 flex-1 bg-transparent text-xs leading-4 outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            data-testid="workspace-file-refresh-button"
            onClick={onRefresh}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.workspace_file_refresh', '刷新文件')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="scrollbar-soft min-h-0 flex-1 overflow-hidden pl-1 pr-2 pb-3">
        {loadingRoot && (
          <p className="px-2 py-3 text-xs text-text-secondary">
            {t('workbench.workspace_file_loading', '正在加载文件...')}
          </p>
        )}
        {error ? (
          <div className="px-2 py-3 text-xs text-red-500">
            <p>{error}</p>
            <button
              type="button"
              data-testid="workspace-file-tree-retry-button"
              className="mt-2 underline"
              onClick={onRefresh}
            >
              {t('workbench.workspace_file_retry', '重试')}
            </button>
          </div>
        ) : treeModel.paths.length > 0 ? (
          <WorkspacePierreFileTree
            key={modelKey}
            modelKey={modelKey}
            treeModel={treeModel}
            query={query}
            onOpenDirectory={onOpenDirectory}
            onOpenFile={onOpenFile}
          />
        ) : !loadingRoot ? (
          <p className="px-2 py-3 text-xs text-text-muted">
            {t('workbench.workspace_file_empty', '没有文件')}
          </p>
        ) : null}
      </div>
    </aside>
  )
}
