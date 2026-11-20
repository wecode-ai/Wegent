import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { Loader2, Search, X } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { createWorkbenchSearchSession } from './workbenchSearchSession'
import { useTranslation } from '@/hooks/useTranslation'
import { isImeEnterEvent } from '@/lib/ime'
import { cn } from '@/lib/utils'
import {
  WORKBENCH_CLOUD_SEARCH_RESULTS_EVENT,
  type WorkbenchCloudSearchResultsDetail,
} from '@/features/workbench/workbenchCloudDataEvents'
import type {
  RuntimeTaskAddress,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkSearchItem,
} from '@/types/api'

interface WorkbenchSearchDialogProps {
  open: boolean
  onClose: () => void
  onSearchRuntimeWork: (request: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  onOpenRuntimeTask: (address: RuntimeTaskAddress) => Promise<void> | void
}

export function WorkbenchSearchDialog({
  open,
  onClose,
  onSearchRuntimeWork,
  onOpenRuntimeTask,
}: WorkbenchSearchDialogProps) {
  if (!open) return null

  return (
    <WorkbenchSearchDialogPanel
      onClose={onClose}
      onSearchRuntimeWork={onSearchRuntimeWork}
      onOpenRuntimeTask={onOpenRuntimeTask}
    />
  )
}

function WorkbenchSearchDialogPanel({
  onClose,
  onSearchRuntimeWork,
  onOpenRuntimeTask,
}: Omit<WorkbenchSearchDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const dialogRef = useDialogKeyboard<HTMLDivElement>(onClose)
  const [query, setQuery] = useState('')
  const trimmedQuery = query.trim()
  const session = useMemo(
    () => createWorkbenchSearchSession(onSearchRuntimeWork),
    [onSearchRuntimeWork]
  )
  const subscribe = useCallback(
    (listener: () => void) => session.subscribe(listener, trimmedQuery),
    [session, trimmedQuery]
  )
  const response = useSyncExternalStore(subscribe, session.getSnapshot, session.getServerSnapshot)
  const items = trimmedQuery ? response.items : []
  const { selectedIndex, searchedQuery } = response
  const loading = Boolean(trimmedQuery) && response.query === trimmedQuery && response.loading
  const error =
    response.query === trimmedQuery && response.failed ? t('workbench.search_failed') : null
  const setSelectedIndex = session.select
  useDOMEvent<CustomEvent<WorkbenchCloudSearchResultsDetail>>(
    'window',
    WORKBENCH_CLOUD_SEARCH_RESULTS_EVENT,
    event => session.acceptCloud(event.detail)
  )
  const selectedItem = items[selectedIndex] ?? null
  const hasQuery = trimmedQuery.length > 0
  const statusLabel = useMemo(() => {
    if (loading) return t('workbench.search_loading')
    if (error) return error
    if (hasQuery && searchedQuery === trimmedQuery && items.length === 0) {
      return t('workbench.search_no_results')
    }
    return null
  }, [error, hasQuery, items.length, loading, searchedQuery, t, trimmedQuery])

  const openItem = (item: RuntimeWorkSearchItem | null) => {
    if (!item) return
    void Promise.resolve(onOpenRuntimeTask(item.address)).finally(onClose)
  }

  return (
    <div
      data-testid="workbench-search-overlay"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/18 px-4 pt-[22vh] backdrop-blur-[1px]"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.search_conversations')}
        data-testid="workbench-search-dialog"
        className="w-full max-w-[520px] overflow-hidden rounded-[18px] bg-popover text-text-primary shadow-[0_24px_70px_rgba(15,23,42,0.20)] ring-[0.5px] ring-border"
      >
        <div className="group/search flex h-14 items-center gap-3 border-b border-border/70 px-4">
          <Search className="h-4 w-4 shrink-0 text-text-muted group-focus-within/search:text-text-primary" />
          <input
            data-testid="workbench-search-input"
            value={query}
            onChange={event => {
              const nextQuery = event.target.value
              setQuery(nextQuery)
              setSelectedIndex(0)
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelectedIndex(index => Math.min(index + 1, Math.max(items.length - 1, 0)))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex(index => Math.max(index - 1, 0))
                return
              }
              if (isImeEnterEvent(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                openItem(selectedItem)
              }
            }}
            placeholder={t('workbench.search_conversations')}
            className="workbench-chrome-input h-full min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
          <button
            type="button"
            data-testid="workbench-search-close-button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text-primary"
            aria-label={t('workbench.close_dialog')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[420px] min-h-[120px] overflow-y-auto px-2 py-3">
          {items.length > 0 && (
            <div className="px-3 pb-2 text-xs text-text-muted">{t('workbench.chats')}</div>
          )}
          {items.map((item, index) => (
            <button
              key={`${item.address.deviceId}:${item.address.taskId}:${item.messageId ?? index}`}
              type="button"
              data-testid={`workbench-search-result-${index}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => openItem(item)}
              className={cn(
                'flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left',
                index === selectedIndex ? 'bg-surface' : 'hover:bg-surface/70'
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-5 text-text-primary">
                  {item.title}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-text-secondary">
                  {renderHighlightedSnippet(item.snippet, trimmedQuery)}
                </div>
              </div>
              <div className="flex max-w-[150px] shrink-0 flex-col items-end gap-1 text-xs text-text-muted">
                <span className="max-w-full truncate">{item.project?.name || item.deviceName}</span>
              </div>
            </button>
          ))}
          {statusLabel && (
            <div className="flex min-h-[96px] items-center justify-center px-4 text-sm text-text-muted">
              {statusLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function renderHighlightedSnippet(snippet: string, query: string) {
  if (!query) return snippet
  const index = snippet.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return snippet
  const before = snippet.slice(0, index)
  const match = snippet.slice(index, index + query.length)
  const after = snippet.slice(index + query.length)
  return (
    <>
      {before}
      <mark className="rounded bg-primary/15 px-0.5 text-primary">{match}</mark>
      {after}
    </>
  )
}
