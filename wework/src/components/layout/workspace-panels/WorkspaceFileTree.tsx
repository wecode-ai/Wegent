import {
  hotkeysCoreFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type SetStateFn,
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { ChevronRight, FileText, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { WorkspaceFileEntry } from '@/types/workspace-files'

const WORKSPACE_ROOT_ITEM_ID = '__workspace_root__'
const WORKSPACE_TREE_FEATURES = [syncDataLoaderFeature, hotkeysCoreFeature]

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
  onExpandedPathsChange: SetStateFn<string[]>
  onRefresh: () => void
}

interface WorkspaceTreeItemData {
  id: string
  name: string
  entry: WorkspaceFileEntry | null
  isDirectory: boolean
}

interface WorkspaceFileTreeNodeProps {
  item: ItemInstance<WorkspaceTreeItemData>
  activeDirectoryPath: string
  selectedPath?: string | null
  loadingPaths: Set<string>
}

function sortEntries(entries: WorkspaceFileEntry[]) {
  return [...entries].sort((first, second) => {
    if (first.isDirectory !== second.isDirectory) {
      return first.isDirectory ? -1 : 1
    }
    return first.name.localeCompare(second.name)
  })
}

function entryMatchesTree(
  entry: WorkspaceFileEntry,
  entriesByPath: Record<string, WorkspaceFileEntry[]>,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true
  if (entry.name.toLowerCase().includes(normalizedQuery)) return true
  if (!entry.isDirectory) return false
  return (entriesByPath[entry.path] ?? []).some(child =>
    entryMatchesTree(child, entriesByPath, normalizedQuery),
  )
}

function WorkspaceTreeIndent({ depth }: { depth: number }) {
  if (depth <= 0) return null

  return (
    <span aria-hidden="true" className="flex h-full shrink-0">
      {Array.from({ length: depth }).map((_, index) => (
        <span
          key={index}
          data-testid="workspace-tree-indent-guide"
          className="relative h-full w-5 shrink-0 before:absolute before:inset-y-0 before:left-2 before:w-px before:bg-border"
        />
      ))}
    </span>
  )
}

function WorkspaceFileTreeNode({
  item,
  activeDirectoryPath,
  selectedPath,
  loadingPaths,
}: WorkspaceFileTreeNodeProps) {
  const { t } = useTranslation('common')
  const itemData = item.getItemData()
  const depth = item.getItemMeta().level
  const isActiveDirectory =
    itemData.entry?.isDirectory && activeDirectoryPath === itemData.entry.path
  const isSelectedFile =
    itemData.entry && !itemData.entry.isDirectory && selectedPath === itemData.entry.path
  const loadingDirectory =
    itemData.entry?.isDirectory && loadingPaths.has(itemData.entry.path)

  return (
    <>
      <button
        {...item.getProps()}
        type="button"
        data-testid={itemData.isDirectory ? 'workspace-directory-row' : 'workspace-file-row'}
        data-depth={depth}
        className={cn(
          'flex h-8 w-full items-center rounded-md pr-2 text-left text-sm outline-none transition-colors',
          isActiveDirectory
            ? 'bg-background text-text-primary ring-1 ring-primary'
            : isSelectedFile
              ? 'bg-muted text-text-primary'
              : 'text-text-secondary hover:bg-muted hover:text-text-primary',
        )}
      >
        <WorkspaceTreeIndent depth={depth} />
        <span className="flex h-8 w-5 shrink-0 items-center justify-center">
          {itemData.isDirectory ? (
            <ChevronRight
              className={cn(
                'h-4 w-4 text-text-secondary transition-transform',
                item.isExpanded() && 'rotate-90',
              )}
            />
          ) : (
            <FileText className="h-4 w-4 text-text-muted" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{itemData.name}</span>
      </button>
      {loadingDirectory && (
        <div
          data-testid="workspace-directory-loading-row"
          data-depth={depth + 1}
          className="flex h-8 items-center pr-2 text-sm text-text-muted"
        >
          <WorkspaceTreeIndent depth={depth + 1} />
          <span className="truncate">
            {t('workbench.workspace_file_loading', '正在加载文件...')}
          </span>
        </div>
      )}
    </>
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
  onExpandedPathsChange,
  onRefresh,
}: WorkspaceFileTreeProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const itemDataById = useMemo(() => {
    const next = new Map<string, WorkspaceTreeItemData>()
    next.set(WORKSPACE_ROOT_ITEM_ID, {
      id: WORKSPACE_ROOT_ITEM_ID,
      name: rootPath || '/',
      entry: null,
      isDirectory: true,
    })
    Object.values(entriesByPath).forEach(entries => {
      entries.forEach(entry => {
        next.set(entry.path, {
          id: entry.path,
          name: entry.name,
          entry,
          isDirectory: entry.isDirectory,
        })
      })
    })
    return next
  }, [entriesByPath, rootPath])
  const searchExpandedPaths = useMemo(
    () => Object.values(entriesByPath)
      .flat()
      .filter(entry => entry.isDirectory)
      .map(entry => entry.path),
    [entriesByPath],
  )
  const expandedItems = useMemo(
    () => normalizedQuery ? searchExpandedPaths : Array.from(expandedPaths),
    [expandedPaths, normalizedQuery, searchExpandedPaths],
  )
  const visibleRootEntries = useMemo(
    () => sortEntries(entriesByPath[rootPath] ?? []).filter(entry =>
      entryMatchesTree(entry, entriesByPath, normalizedQuery),
    ),
    [entriesByPath, normalizedQuery, rootPath],
  )
  const loadingRoot = loadingPaths.has(rootPath)
  const tree = useTree<WorkspaceTreeItemData>({
    rootItemId: WORKSPACE_ROOT_ITEM_ID,
    state: {
      expandedItems,
    },
    setExpandedItems: onExpandedPathsChange,
    getItemName: item => item.getItemData().name,
    isItemFolder: item => item.getItemData().isDirectory,
    onPrimaryAction: item => {
      const entry = item.getItemData().entry
      if (!entry) return
      if (entry.isDirectory) {
        onOpenDirectory(entry)
      } else {
        onOpenFile(entry)
      }
    },
    dataLoader: {
      getItem: itemId =>
        itemDataById.get(itemId) ?? {
          id: itemId,
          name: itemId.split('/').pop() || itemId,
          entry: null,
          isDirectory: false,
        },
      getChildren: itemId => {
        if (itemId === WORKSPACE_ROOT_ITEM_ID) {
          return visibleRootEntries.map(entry => entry.path)
        }
        return sortEntries(entriesByPath[itemId] ?? [])
          .filter(entry => entryMatchesTree(entry, entriesByPath, normalizedQuery))
          .map(entry => entry.path)
      },
    },
    ignoreHotkeysOnInputs: true,
    features: WORKSPACE_TREE_FEATURES,
  })

  return (
    <aside
      data-testid="workspace-file-tree"
      className="flex h-full min-h-0 w-[240px] shrink-0 flex-col border-l border-border bg-background"
    >
      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2">
          <Search className="h-4 w-4 text-text-muted" />
          <input
            data-testid="workspace-file-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('workbench.workspace_file_search', '筛选文件...')}
            aria-label={t('workbench.workspace_file_search', '筛选文件...')}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
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

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loadingRoot && (
          <p className="px-2 py-3 text-sm text-text-secondary">
            {t('workbench.workspace_file_loading', '正在加载文件...')}
          </p>
        )}
        {error ? (
          <div className="px-2 py-3 text-sm text-red-500">
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
        ) : (
          <div {...tree.getContainerProps(t('workbench.workspace_tab_open_file', '打开文件'))} className="space-y-0.5">
            {tree.getItems().map(item => (
              <WorkspaceFileTreeNode
                key={item.getId()}
                item={item}
                activeDirectoryPath={activeDirectoryPath}
                selectedPath={selectedPath}
                loadingPaths={loadingPaths}
              />
            ))}
            {visibleRootEntries.length === 0 && !loadingRoot && (
              <p className="px-2 py-3 text-sm text-text-muted">
                {t('workbench.workspace_file_empty', '没有文件')}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
