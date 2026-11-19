import { ActionMenu } from '@/components/common/ActionMenu'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useTranslation } from '@/hooks/useTranslation'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import {
  embeddedBrowserHistoryEntryKey,
  type EmbeddedBrowserHistoryEntry,
} from '@/lib/embedded-browser-history'
import { navigateTo } from '@/lib/navigation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { useIntersectionEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronDown, Globe, History, Loader2, MoreHorizontal, Search, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createBrowserHistoryResource } from './browserHistoryResource'
import { ClearBrowserDataDialog } from './ClearBrowserDataDialog'

const OPEN_REQUEST_RETRY_DELAY_MS = 100
const OPEN_REQUEST_RETRY_LIMIT = 50

interface HistoryGroup {
  key: string
  visitTimeMs: number
  entries: EmbeddedBrowserHistoryEntry[]
}

function groupHistoryEntries(entries: EmbeddedBrowserHistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  for (const entry of entries) {
    const key = new Date(entry.visitTimeMs).toDateString()
    const last = groups[groups.length - 1]
    if (last && last.key === key) {
      last.entries.push(entry)
    } else {
      groups.push({ key, visitTimeMs: entry.visitTimeMs, entries: [entry] })
    }
  }
  return groups
}

function entryHostname(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function entryFaviconUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.origin}/favicon.ico`
  } catch {
    return null
  }
}

function formatGroupDate(visitTimeMs: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(visitTimeMs))
}

function formatEntryTime(visitTimeMs: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(visitTimeMs))
}

function openEntryInBrowser(url: string) {
  navigateTo('/')
  let attempts = 0
  const tryOpen = () => {
    attempts += 1
    if (requestEmbeddedBrowserOpen(url)) return
    if (attempts < OPEN_REQUEST_RETRY_LIMIT) {
      window.setTimeout(tryOpen, OPEN_REQUEST_RETRY_DELAY_MS)
    }
  }
  window.setTimeout(tryOpen, OPEN_REQUEST_RETRY_DELAY_MS)
}

function HistoryEntryFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  const faviconUrl = failed ? null : entryFaviconUrl(url)
  if (!faviconUrl) {
    return <Globe className="h-4 w-4 text-text-secondary" aria-hidden="true" />
  }
  return (
    <img
      alt=""
      src={faviconUrl}
      onError={() => setFailed(true)}
      className="h-4 w-4 rounded-[3px] object-contain"
    />
  )
}

function HistoryEntryRow({
  entry,
  checked,
  disabled,
  locale,
  onOpen,
  onRemove,
  onSelect,
}: {
  entry: EmbeddedBrowserHistoryEntry
  checked: boolean
  disabled: boolean
  locale: string
  onOpen: () => void
  onRemove: () => void
  onSelect: (checked: boolean) => void
}) {
  const { t } = useTranslation('common')
  const hostname = entryHostname(entry.url)
  const title = entry.title || hostname
  const checkboxId = `browser-history-select-${entry.id}-${entry.visitTimeMs}`

  return (
    <div
      data-testid={`browser-history-entry-${entry.id}`}
      className="flex items-center gap-3 px-4 py-2 focus-within:bg-muted hover:bg-muted"
    >
      <label className="relative flex shrink-0 items-center" htmlFor={checkboxId}>
        <Checkbox
          id={checkboxId}
          data-testid={`browser-history-entry-select-${entry.id}`}
          checked={checked}
          disabled={disabled}
          onCheckedChange={checked => onSelect(checked === true)}
          className="h-4 w-4 accent-primary disabled:opacity-50"
        />
        <span className="sr-only">{t('workbench.browser_history_select_entry', { title })}</span>
      </label>
      <HistoryEntryFavicon url={entry.url} />
      <a
        href={entry.url}
        aria-label={t('workbench.browser_history_open_entry', { title })}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : undefined}
        onClick={event => {
          event.preventDefault()
          if (!disabled) onOpen()
        }}
        className="flex min-w-0 flex-1 items-baseline gap-2 text-start text-sm font-normal text-text-primary underline-offset-2 hover:underline"
      >
        <span className="min-w-0 truncate">{title}</span>
        <span className="min-w-0 truncate text-text-secondary">{hostname}</span>
      </a>
      <span className="shrink-0 text-sm text-text-secondary">
        {formatEntryTime(entry.visitTimeMs, locale)}
      </span>
      <ActionMenu
        ariaLabel={t('workbench.browser_history_entry_actions', { title })}
        testId={`browser-history-entry-menu-${entry.id}`}
        icon={MoreHorizontal}
        placement="bottom-end"
        width={200}
        disabled={disabled}
        density="dense"
        triggerClassName="flex shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-50"
        items={[
          {
            label: t('workbench.browser_history_open_page'),
            testId: `browser-history-entry-open-${entry.id}`,
            onSelect: onOpen,
          },
          {
            label: t('workbench.browser_history_remove'),
            testId: `browser-history-entry-remove-${entry.id}`,
            danger: true,
            disabled,
            onSelect: onRemove,
          },
        ]}
      />
    </div>
  )
}

export function BrowserHistoryPage() {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.language
  const [resource] = useState(() => createBrowserHistoryResource())
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const {
    searchInput,
    query,
    entries,
    cursor,
    loading,
    loadingMore,
    loadError,
    paginationError,
    removing,
    clearing,
  } = state
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedPage, setExpandedPage] = useState(state.firstPageVersion)
  if (expandedPage !== state.firstPageVersion) {
    setExpandedPage(state.firstPageVersion)
    const firstKey = groupHistoryEntries(entries)[0]?.key
    setExpandedGroups(firstKey ? new Set([firstKey]) : new Set())
  }
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadNextPage = resource.loadNextPage
  const reloadFirstPage = resource.reload
  const intersectHistory = useCallback<IntersectionObserverCallback>(
    observed => {
      if (cursor && observed.some(entry => entry.isIntersecting)) void resource.loadNextPage()
    },
    [resource, cursor]
  )
  useIntersectionEvent(sentinelRef, intersectHistory, {
    enabled: !!cursor && !loading && !loadError && !paginationError,
  })
  const groups = useMemo(() => groupHistoryEntries(entries), [entries])

  const removeEntries = async (ids: string[]) => {
    if (await resource.remove(ids)) {
      const removed = new Set(ids)
      setSelected(current => new Set([...current].filter(key => !removed.has(key))))
    }
  }

  const selectedIds = useMemo(
    () =>
      entries
        .filter(entry => selected.has(embeddedBrowserHistoryEntryKey(entry)))
        .map(entry => entry.id),
    [entries, selected]
  )

  const clearBrowsingData = async () => {
    if (await resource.clear()) {
      setClearDialogOpen(false)
      setSelected(new Set())
    }
  }

  const toggleGroup = (key: string) => {
    setExpandedGroups(current => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const loadFailure = (
    <div
      data-testid="browser-history-load-error"
      className="flex items-center justify-between gap-4 px-4 py-3"
    >
      <span className="text-sm text-text-secondary">
        {t('workbench.browser_history_load_error')}
      </span>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="browser-history-retry-button"
        onClick={reloadFirstPage}
        className="h-8 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover"
      >
        {t('workbench.browser_history_retry')}
      </ControlButton>
    </div>
  )

  let content
  if (loading && entries.length === 0) {
    content = (
      <div
        data-testid="browser-history-loading"
        className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-text-secondary"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('workbench.browser_history_loading')}
      </div>
    )
  } else if (loadError && entries.length === 0) {
    content = loadFailure
  } else if (groups.length === 0) {
    const searching = query.trim().length > 0
    content = (
      <div
        data-testid="browser-history-empty"
        className="flex flex-col items-center gap-2 px-4 py-10 text-center"
      >
        <History className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        <span className="text-sm font-medium text-text-primary">
          {searching
            ? t('workbench.browser_history_no_results')
            : t('workbench.browser_history_empty')}
        </span>
        <span className="text-sm text-text-secondary">
          {searching
            ? t('workbench.browser_history_no_results_description')
            : t('workbench.browser_history_empty_description')}
        </span>
      </div>
    )
  } else {
    content = (
      <div className="flex flex-col">
        {groups.map((group, groupIndex) => {
          const expanded = expandedGroups.has(group.key)
          const contentId = `browser-history-group-content-${groupIndex}`
          return (
            <div key={group.key} data-testid={`browser-history-group-${group.key}`}>
              <ControlButton
                variant="unstyled"
                type="button"
                aria-expanded={expanded}
                aria-controls={contentId}
                data-testid={`browser-history-group-toggle-${group.key}`}
                onClick={() => toggleGroup(group.key)}
                className="flex w-full items-center gap-2 px-4 py-2 text-start text-sm font-medium text-text-primary hover:bg-muted"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 text-text-secondary transition-transform ${expanded ? '' : '-rotate-90'}`}
                />
                {formatGroupDate(group.visitTimeMs, locale)}
              </ControlButton>
              {expanded ? (
                <div id={contentId}>
                  {group.entries.map(entry => (
                    <HistoryEntryRow
                      key={embeddedBrowserHistoryEntryKey(entry)}
                      entry={entry}
                      checked={selected.has(embeddedBrowserHistoryEntryKey(entry))}
                      disabled={removing}
                      locale={locale}
                      onOpen={() => openEntryInBrowser(entry.url)}
                      onRemove={() => void removeEntries([entry.id])}
                      onSelect={checked => {
                        const key = embeddedBrowserHistoryEntryKey(entry)
                        setSelected(current => {
                          const next = new Set(current)
                          if (checked) {
                            next.add(key)
                          } else {
                            next.delete(key)
                          }
                          return next
                        })
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div data-testid="browser-history-page" className="flex h-full flex-col">
      <div className="mb-4 flex items-center gap-2">
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="browser-history-back-button"
          aria-label={t('common.back', '返回')}
          onClick={() => navigateTo('/settings/browser')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
        >
          <ChevronDown className="h-4 w-4 rotate-90" />
        </ControlButton>
        <nav aria-label="breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="browser-history-breadcrumb-browser"
            onClick={() => navigateTo('/settings/browser')}
            className="shrink-0 text-text-secondary hover:text-text-primary hover:underline"
          >
            {t('workbench.settings_nav_browser', '浏览器')}
          </ControlButton>
          <span className="text-text-muted">/</span>
          <span className="truncate font-medium text-text-primary">
            {t('workbench.browser_history_title')}
          </span>
        </nav>
      </div>

      <div className="sticky top-0 z-10 mb-4 bg-background pb-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          />
          <ControlInput
            type="search"
            data-testid="browser-history-search"
            value={searchInput}
            aria-label={t('workbench.browser_history_search')}
            placeholder={t('workbench.browser_history_search')}
            onChange={event => resource.changeSearch(event.target.value)}
            className="h-9 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted keyboard:focus:border-primary focus:bg-background"
          />
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {t('workbench.browser_history_all_time')}
        </h2>
        <div className="flex items-center gap-2">
          {selectedIds.length > 0 ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="browser-history-remove-selected"
              disabled={removing}
              onClick={() => void removeEntries(selectedIds)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:opacity-50"
            >
              {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('workbench.browser_history_remove_selected')}
            </ControlButton>
          ) : null}
          <ControlButton
            type="button"
            data-testid="browser-history-clear-data-button"
            disabled={removing || clearing}
            onClick={() => setClearDialogOpen(true)}
            variant="destructive-ghost"
            size="sm"
          >
            <Trash2 className="h-4 w-4" />
            {t('workbench.browser_settings_clear_action')}
          </ControlButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-surface/70">
        {loadError && entries.length > 0 ? loadFailure : null}
        {content}
        {cursor && !loading && !loadError ? (
          <div
            ref={sentinelRef}
            data-testid="browser-history-load-more-sentinel"
            className="flex items-center justify-center px-4 py-3"
          >
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin text-text-secondary" /> : null}
          </div>
        ) : null}
        {paginationError ? (
          <div
            data-testid="browser-history-pagination-error"
            className="flex items-center justify-between gap-4 border-t border-border px-4 py-3"
          >
            <span className="text-sm text-text-secondary">
              {t('workbench.browser_history_pagination_error')}
            </span>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="browser-history-pagination-retry-button"
              onClick={() => void loadNextPage()}
              className="h-8 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover"
            >
              {t('workbench.browser_history_retry')}
            </ControlButton>
          </div>
        ) : null}
      </div>

      {clearDialogOpen ? (
        <ClearBrowserDataDialog
          loading={clearing}
          onCancel={() => setClearDialogOpen(false)}
          onConfirm={() => void clearBrowsingData()}
        />
      ) : null}
      <TransientNotice
        message={state.actionFailed ? t('workbench.browser_history_action_error') : null}
        tone="error"
        onClear={resource.clearNotice}
      />
    </div>
  )
}
