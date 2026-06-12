import { ChevronRight, FileText, Folder, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkspaceFileEntry } from '@/types/workspace-files'

interface WorkspaceFileTreeProps {
  rootPath: string
  currentPath: string
  entries: WorkspaceFileEntry[]
  selectedPath?: string | null
  loading: boolean
  error?: string | null
  onOpenDirectory: (path: string) => void
  onOpenFile: (entry: WorkspaceFileEntry) => void
  onRefresh: () => void
}

export function WorkspaceFileTree({
  rootPath,
  currentPath,
  entries,
  selectedPath,
  loading,
  error,
  onOpenDirectory,
  onOpenFile,
  onRefresh,
}: WorkspaceFileTreeProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleEntries = useMemo(
    () =>
      entries.filter(entry =>
        normalizedQuery ? entry.name.toLowerCase().includes(normalizedQuery) : true,
      ),
    [entries, normalizedQuery],
  )
  const parentPath =
    currentPath !== rootPath && currentPath.includes('/')
      ? currentPath.slice(0, currentPath.lastIndexOf('/')) || '/'
      : null

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
        <p className="mb-2 truncate px-2 text-xs text-text-muted">{currentPath}</p>
        {loading && (
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
          <div className="space-y-0.5">
            {parentPath && (
              <button
                type="button"
                data-testid="workspace-file-parent-row"
                onClick={() => onOpenDirectory(parentPath)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-text-secondary hover:bg-muted"
              >
                <ChevronRight className="h-3.5 w-3.5 rotate-180" />
                ..
              </button>
            )}
            {visibleEntries.map(entry => (
              <button
                key={entry.path}
                type="button"
                data-testid={entry.isDirectory ? 'workspace-directory-row' : 'workspace-file-row'}
                onClick={() => entry.isDirectory ? onOpenDirectory(entry.path) : onOpenFile(entry)}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
                  selectedPath === entry.path
                    ? 'bg-primary/10 text-text-primary'
                    : 'text-text-secondary hover:bg-muted hover:text-text-primary'
                }`}
              >
                {entry.isDirectory ? (
                  <Folder className="h-4 w-4 shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            ))}
            {visibleEntries.length === 0 && !loading && (
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
