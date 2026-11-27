import {
  WORKBENCH_CLOUD_SEARCH_RESULTS_EVENT,
  type WorkbenchCloudSearchResultsDetail,
} from '@/features/workbench/workbenchCloudDataEvents'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  RuntimeTaskAddress,
  RuntimeWorkSearchItem,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
} from '@/types/api'
import { Command, CommandInput, CommandItem, CommandList } from '@ui-sdk/react/command'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { controlInput, controlOption } from '@wegent/collaboration/controls/recipes'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Loader2, Search, X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { createWorkbenchSearchSession } from './workbenchSearchSession'

interface WorkbenchSearchDialogProps {
  open: boolean
  suspended?: boolean
  onClose: () => void
  onSearchRuntimeWork: (request: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  onOpenRuntimeTask: (address: RuntimeTaskAddress) => Promise<void> | void
}

export function WorkbenchSearchDialog({ open, ...props }: WorkbenchSearchDialogProps) {
  if (!open) return null

  return createPortal(<WorkbenchSearchDialogPanel {...props} />, document.body)
}

function WorkbenchSearchDialogPanel({
  suspended,
  onClose,
  onSearchRuntimeWork,
  onOpenRuntimeTask,
}: Omit<WorkbenchSearchDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLDivElement>(null)
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
  const { searchedQuery } = response
  const loading = Boolean(trimmedQuery) && response.query === trimmedQuery && response.loading
  const error =
    response.query === trimmedQuery && response.failed ? t('workbench.search_failed') : null
  useDOMEvent<CustomEvent<WorkbenchCloudSearchResultsDetail>>(
    'window',
    WORKBENCH_CLOUD_SEARCH_RESULTS_EVENT,
    event => session.acceptCloud(event.detail)
  )
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
    return Promise.resolve(onOpenRuntimeTask(item.address)).finally(onClose)
  }

  return (
    <div
      data-testid="workbench-search-overlay"
      className={cn(
        'fixed inset-0 z-modal items-start justify-center bg-black/18 px-4 pt-[22vh] backdrop-blur-[1px]',
        suspended ? 'hidden' : 'flex'
      )}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <DialogSurface
        onClose={onClose}
        suspended={suspended}
        render={
          <div
            ref={dialogRef}
            aria-label={t('workbench.search_conversations')}
            data-testid="workbench-search-dialog"
            className="w-full max-w-[520px] overflow-hidden rounded-[18px] bg-popover text-text-primary shadow-[0_24px_70px_rgba(15,23,42,0.20)] ring-[0.5px] ring-border"
          />
        }
      >
        <Command query={query} filter={false} loop={false} onQueryChange={setQuery}>
          <div className="group/search flex h-14 items-center gap-3 border-b border-border/70 px-4">
            <Search className="h-4 w-4 shrink-0 text-text-muted group-focus-within/search:text-text-primary" />
            <CommandInput
              aria-label={t('workbench.search_conversations')}
              data-testid="workbench-search-input"
              placeholder={t('workbench.search_conversations')}
              className={cn(controlInput, 'min-w-0 flex-1')}
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="workbench-search-close-button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text-primary"
              aria-label={t('workbench.close_dialog')}
            >
              <X className="h-4 w-4" />
            </ControlButton>
          </div>

          <CommandList
            className="max-h-[420px] min-h-[120px] overflow-y-auto px-2 py-3"
            aria-label={t('workbench.chats')}
          >
            {items.length > 0 && (
              <div className="px-3 pb-2 text-xs text-text-muted">{t('workbench.chats')}</div>
            )}
            {items.map((item, index) => (
              <CommandItem
                key={JSON.stringify([
                  item.address.deviceId,
                  item.address.taskId,
                  item.address.workspacePath,
                  item.messageId,
                ])}
                value={JSON.stringify([
                  item.address.deviceId,
                  item.address.taskId,
                  item.address.workspacePath,
                  item.messageId,
                ])}
                data-testid={`workbench-search-result-${index}`}
                onSelect={() => openItem(item)}
                className={cn(controlOption, 'items-start gap-3 px-3 py-2.5')}
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
                  <span className="max-w-full truncate">
                    {item.project?.name || item.deviceName}
                  </span>
                </div>
              </CommandItem>
            ))}
            {statusLabel && (
              <div className="flex min-h-[96px] items-center justify-center px-4 text-sm text-text-muted">
                {statusLabel}
              </div>
            )}
          </CommandList>
        </Command>
      </DialogSurface>
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
