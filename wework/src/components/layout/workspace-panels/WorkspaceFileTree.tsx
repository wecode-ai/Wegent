import { useTranslation } from '@/hooks/useTranslation'
import { writeWorkspacePathDragData } from '@/lib/workspace-path-transfer'
import type { WorkspaceFileEntry } from '@/types/workspace-files'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { VirtualTree } from '@wegent/collaboration/controls/VirtualTree'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Folder, FolderOpen, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  createWorkspaceTreeModel,
  getEntryByTreePath,
  type WorkspaceTreeModel,
} from './workspaceFileTreeModel'

import { createFileTreeData, resolveFileTreePath } from './fileTreeData'
import { useFileTreeExpansion } from './useFileTreeExpansion'
import { WorkspaceFileIcon } from './WorkspaceFileIcon'

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

function WorkspaceSdkFileTree({
  treeModel,
  query,
  visible,
  rootPath,
  onOpenDirectory,
  onOpenFile,
}: {
  treeModel: WorkspaceTreeModel
  query: string
  visible: boolean
  rootPath: string
  onOpenDirectory: (entry: WorkspaceFileEntry) => void
  onOpenFile: (entry: WorkspaceFileEntry) => void
}) {
  const data = useMemo(() => createFileTreeData(treeModel.paths, query), [treeModel.paths, query])
  const { values: visibleExpanded, setValues: setExpanded } = useFileTreeExpansion(
    data,
    query,
    treeModel.expandedTreePaths
  )
  const selected = resolveFileTreePath(data, treeModel.selectedTreePath)

  return (
    <VirtualTree
      data-testid="workspace-file-tree-pierre"
      aria-label={rootPath}
      items={data.items}
      value={selected}
      current={selected}
      activation="automatic"
      expanded={visibleExpanded}
      visible={visible}
      scrollToValue={selected}
      scrollAlign="center"
      viewportClassName="h-full w-full"
      onExpandedChange={(next, details) => {
        setExpanded(next)
        if (details.reason === 'item-press' || details.reason === 'imperative') return
        for (const path of next.filter(path => !visibleExpanded.includes(path))) {
          const entry = getEntryByTreePath(
            treeModel.entryByTreePath,
            path,
            treeModel.caseInsensitivePaths
          )
          if (entry?.isDirectory) onOpenDirectory(entry)
        }
      }}
      onValueChange={path => {
        if (!path) return
        const entry = getEntryByTreePath(
          treeModel.entryByTreePath,
          path,
          treeModel.caseInsensitivePaths
        )
        if (!entry) return
        if (entry.isDirectory) {
          setExpanded(Array.from(new Set([...visibleExpanded, path])))
          onOpenDirectory(entry)
        } else onOpenFile(entry)
      }}
      itemProps={item => ({
        draggable: true,
        onDragStart: event => {
          const entry = getEntryByTreePath(
            treeModel.entryByTreePath,
            item.value,
            treeModel.caseInsensitivePaths
          )
          if (!entry) return
          writeWorkspacePathDragData(event.dataTransfer, [
            { path: entry.path, isDirectory: entry.isDirectory },
          ])
          event.dataTransfer.effectAllowed = 'copy'
        },
      })}
      renderLabel={(item, state) => (
        <>
          {state.branch ? (
            state.expanded ? (
              <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
            )
          ) : (
            <WorkspaceFileIcon
              path={item.value}
              testId={`workspace-file-tree-icon-${item.value}`}
            />
          )}
          <span className="truncate">{item.label}</span>
        </>
      )}
    />
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
  return (
    <aside
      data-testid="workspace-file-tree"
      className="flex h-full min-h-0 w-[240px] shrink-0 flex-col border-l border-border bg-background"
    >
      <div className="px-3 pb-1.5 pt-2">
        <div className="relative flex items-center gap-1.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <ControlInput
            data-testid="workspace-file-search-input"
            value={query}
            onChange={event => setSearch({ path: selectedPath, value: event.target.value })}
            placeholder={t('workbench.workspace_file_search', '筛选文件...')}
            aria-label={t('workbench.workspace_file_search', '筛选文件...')}
            className="min-w-0 flex-1 pl-9"
          />
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="workspace-file-refresh-button"
            onClick={onRefresh}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.workspace_file_refresh', '刷新文件')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </ControlButton>
        </div>
      </div>

      <div className="scrollbar-soft min-h-0 flex-1 overflow-hidden pl-1 pr-2 pb-3">
        {loadingRoot && (
          <p className="px-2 py-3 text-xs text-text-secondary">
            {t('workbench.workspace_file_loading', '正在加载文件...')}
          </p>
        )}
        {error ? (
          <div className="px-2 py-3 text-xs text-destructive wework:text-red-500">
            <p>{error}</p>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="workspace-file-tree-retry-button"
              className="mt-2 underline"
              onClick={onRefresh}
            >
              {t('workbench.workspace_file_retry', '重试')}
            </ControlButton>
          </div>
        ) : treeModel.paths.length > 0 ? (
          <WorkspaceSdkFileTree
            key={rootPath}
            treeModel={treeModel}
            rootPath={rootPath}
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
