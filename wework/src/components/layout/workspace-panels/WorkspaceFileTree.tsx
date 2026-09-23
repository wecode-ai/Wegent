import { FileTree, useFileTree } from '@pierre/trees/react'
import type { FileTreeDirectoryHandle, FileTreeItemHandle } from '@pierre/trees'
import { RefreshCw, Search } from 'lucide-react'
import type { DragEvent as ReactDragEvent } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { writeWorkspacePathDragData } from '@/lib/workspace-path-transfer'
import type { WorkspaceFileEntry } from '@/types/workspace-files'
import {
  createWorkspaceTreeModel,
  getEntryByTreePath,
  type WorkspaceTreeModel,
} from './workspaceFileTreeModel'

import { PIERRE_WORKSPACE_FILE_TREE_CSS } from './workspaceFileTreeStyles'

interface WorkspaceFileTreeProps {
  visible?: boolean
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

function isDirectoryHandle(item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle {
  if (!item) return false

  const candidate = item as FileTreeItemHandle & {
    expand?: unknown
    isDirectory?: unknown
  }
  if (typeof candidate.isDirectory === 'function') {
    return candidate.isDirectory()
  }
  return typeof candidate.expand === 'function'
}

function WorkspacePierreFileTree({
  modelKey,
  treeModel,
  query,
  visible,
  onOpenDirectory,
  onOpenFile,
}: {
  modelKey: string
  treeModel: WorkspaceTreeModel
  query: string
  visible: boolean
  onOpenDirectory: (entry: WorkspaceFileEntry) => void
  onOpenFile: (entry: WorkspaceFileEntry) => void
}) {
  const current = useRef({ treeModel, onOpenDirectory, onOpenFile })
  const syncingSelection = useRef(false)
  useLayoutEffect(() => {
    current.current = { treeModel, onOpenDirectory, onOpenFile }
  }, [treeModel, onOpenDirectory, onOpenFile])
  const { model } = useFileTree({
    density: 'compact',
    dragAndDrop: {
      canDrop: () => false,
    },
    flattenEmptyDirectories: true,
    icons: { set: 'complete', colored: true },
    initialExpandedPaths: treeModel.expandedTreePaths,
    initialSelectedPaths: treeModel.selectedTreePath ? [treeModel.selectedTreePath] : [],
    itemHeight: 28,
    onSelectionChange: selectedPaths => {
      if (syncingSelection.current) return
      const { treeModel, onOpenDirectory, onOpenFile } = current.current
      const nextPath = selectedPaths[0]
      if (!nextPath) return

      const entry = getEntryByTreePath(
        treeModel.entryByTreePath,
        nextPath,
        treeModel.caseInsensitivePaths
      )
      if (!entry) return

      if (entry.isDirectory) {
        const item = model.getItem(nextPath)
        if (isDirectoryHandle(item)) {
          item.expand()
        }
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
    treeModel.expandedTreePaths.forEach(path => {
      const item = model.getItem(path)
      if (isDirectoryHandle(item)) {
        item.expand()
      }
    })
  }, [model, treeModel.expandedTreePaths])

  useEffect(() => {
    const path = treeModel.selectedTreePath
    if (!visible || !path || !model.getItem(path)) return
    syncingSelection.current = true
    try {
      const segments = path.split('/')
      for (let index = 1; index < segments.length; index += 1) {
        const item = model.getItem(`${segments.slice(0, index).join('/')}/`)
        if (isDirectoryHandle(item)) item.expand()
      }
      for (const selected of model.getSelectedPaths()) {
        if (selected !== path) model.getItem(selected)?.deselect()
      }
      model.getItem(path)?.select()
      model.scrollToPath(path, { offset: 'center', focus: false })
    } finally {
      syncingSelection.current = false
    }
  }, [model, treeModel.selectedTreePath, visible])

  const handleDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    const row = event.nativeEvent
      .composedPath()
      .find(target => target instanceof HTMLElement && target.hasAttribute('data-item-path')) as
      | HTMLElement
      | undefined
    const treePath = row?.dataset.itemPath
    if (!treePath) return

    const entry = getEntryByTreePath(treeModel.entryByTreePath, treePath)
    if (!entry) return

    writeWorkspacePathDragData(event.dataTransfer, [
      {
        path: entry.path,
        isDirectory: entry.isDirectory,
      },
    ])
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="h-full min-h-0 w-full" onDragStart={handleDragStart}>
      <FileTree
        key={modelKey}
        data-testid="workspace-file-tree-pierre"
        model={model}
        className="block h-full min-h-0 w-full"
      />
    </div>
  )
}

export function WorkspaceFileTree({
  visible = true,
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
  const [search, setSearch] = useState({ path: selectedPath, value: '' })
  const query = search.path === selectedPath ? search.value : ''
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
        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            data-testid="workspace-file-search-input"
            value={query}
            onChange={event => setSearch({ path: selectedPath, value: event.target.value })}
            placeholder={t('workbench.workspace_file_search', '筛选文件...')}
            aria-label={t('workbench.workspace_file_search', '筛选文件...')}
            className="min-w-0 flex-1 bg-transparent text-xs leading-4 outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            data-testid="workspace-file-refresh-button"
            onClick={onRefresh}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
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
            visible={visible}
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
