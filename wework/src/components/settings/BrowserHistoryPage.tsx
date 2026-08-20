import { ChevronDown, Globe, History, Loader2, MoreHorizontal, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useTranslation } from '@/hooks/useTranslation'
import { clearEmbeddedBrowserData, requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import {
  embeddedBrowserHistoryEntryKey,
  embeddedBrowserHistoryNextCursor,
  removeEmbeddedBrowserHistoryEntries,
  searchEmbeddedBrowserHistory,
  type EmbeddedBrowserHistoryCursor,
  type EmbeddedBrowserHistoryEntry,
} from '@/lib/embedded-browser-history'
import { navigateTo } from '@/lib/navigation'
import { ClearBrowserDataDialog } from './ClearBrowserDataDialog'

const SEARCH_DEBOUNCE_MS = 200
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
        <input
          id={checkboxId}
          type="checkbox"
          data-testid={`browser-history-entry-select-${entry.id}`}
          checked={checked}
          disabled={disabled}
          onChange={event => onSelect(event.target.checked)}
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
        triggerClassName="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-50"
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
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<EmbeddedBrowserHistoryEntry[]>([])
  const [cursor, setCursor] = useState<EmbeddedBrowserHistoryCursor | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [paginationError, setPaginationError] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    // Skip the initial mount (searchInput === query): re-scheduling a load for
    // an unchanged query would flash the loading state over rendered entries.
    if (searchInput === query) return
    const timer = window.setTimeout(() => {
      setQuery(searchInput)
      setLoading(true)
      setLoadError(false)
      setPaginationError(false)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput, query])

  const loadFirstPage = useCallback(async (text: string) => {
    const generation = ++generationRef.current
    try {
      const page = await searchEmbeddedBrowserHistory(text)
      if (generation !== generationRef.current) return
      setEntries(page)
      setCursor(embeddedBrowserHistoryNextCursor(page, page.length))
      // The newest day group starts expanded; every other group starts collapsed.
      setExpandedGroups(() => {
        const firstGroupKey = groupHistoryEntries(page)[0]?.key
        return firstGroupKey ? new Set([firstGroupKey]) : new Set()
      })
    } catch (error) {
      console.error('[Wework] Failed to load browsing history', error)
      if (generation !== generationRef.current) return
      setLoadError(true)
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Deferred so the data fetch behaves as an external-system sync, not a
    // synchronous setState cascade inside the effect body.
    const handle = window.setTimeout(() => void loadFirstPage(query), 0)
    return () => window.clearTimeout(handle)
  }, [query, loadFirstPage])

  const reloadFirstPage = useCallback(() => {
    setLoading(true)
    setLoadError(false)
    setPaginationError(false)
    void loadFirstPage(query)
  }, [loadFirstPage, query])

  const loadNextPage = useCallback(async () => {
    if (!cursor || loading || loadingMore) return
    const generation = generationRef.current
    setLoadingMore(true)
    setPaginationError(false)
    try {
      const page = await searchEmbeddedBrowserHistory(query, cursor)
      if (generation !== generationRef.current) return
      setEntries(current => {
        const next = [...current, ...page]
        setCursor(embeddedBrowserHistoryNextCursor(next, page.length))
        return next
      })
    } catch (error) {
      console.error('[Wework] Failed to load more browsing history', error)
      if (generation === generationRef.current) setPaginationError(true)
    } finally {
      if (generation === generationRef.current) setLoadingMore(false)
    }
  }, [cursor, loading, loadingMore, query])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !cursor) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadNextPage()
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [cursor, loadNextPage])

  const groups = useMemo(() => groupHistoryEntries(entries), [entries])

  const removeEntries = useCallback(
    async (ids: string[]) => {
      if (removing || ids.length === 0) return
      setRemoving(true)
      try {
        await removeEmbeddedBrowserHistoryEntries(ids)
        const removedKeys = new Set(ids)
        setSelected(current => {
          const next = new Set(current)
          removedKeys.forEach(key => next.delete(key))
          return next
        })
        await loadFirstPage(query)
      } catch (error) {
        console.error('[Wework] Failed to remove browsing history entries', error)
        setNotice(t('workbench.browser_history_action_error'))
      } finally {
        setRemoving(false)
      }
    },
    [removing, query, loadFirstPage, t]
  )

  const selectedIds = useMemo(
    () =>
      entries
        .filter(entry => selected.has(embeddedBrowserHistoryEntryKey(entry)))
        .map(entry => entry.id),
    [entries, selected]
  )

  const clearBrowsingData = useCallback(async () => {
    setClearing(true)
    try {
      await clearEmbeddedBrowserData()
      setClearDialogOpen(false)
      setSelected(new Set())
      await loadFirstPage(query)
    } catch (error) {
      console.error('[Wework] Failed to clear browsing data', error)
      setNotice(t('workbench.browser_history_action_error'))
    } finally {
      setClearing(false)
    }
  }, [loadFirstPage, query, t])

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

  let content
  if (loading) {
    content = (
      <div
        data-testid="browser-history-loading"
        className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-text-secondary"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('workbench.browser_history_loading')}
      </div>
    )
  } else if (loadError) {
    content = (
      <div
        data-testid="browser-history-load-error"
        className="flex items-center justify-between gap-4 px-4 py-3"
      >
        <span className="text-sm text-text-secondary">
          {t('workbench.browser_history_load_error')}
        </span>
        <button
          type="button"
          data-testid="browser-history-retry-button"
          onClick={reloadFirstPage}
          className="h-8 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover"
        >
          {t('workbench.browser_history_retry')}
        </button>
      </div>
    )
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
              <button
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
              </button>
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
        <button
          type="button"
          data-testid="browser-history-back-button"
          aria-label={t('common.back', '返回')}
          onClick={() => navigateTo('/settings/browser')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
        >
          <ChevronDown className="h-4 w-4 rotate-90" />
        </button>
        <nav aria-label="breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <button
            type="button"
            data-testid="browser-history-breadcrumb-browser"
            onClick={() => navigateTo('/settings/browser')}
            className="shrink-0 text-text-secondary hover:text-text-primary hover:underline"
          >
            {t('workbench.settings_nav_browser', '浏览器')}
          </button>
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
          <input
            type="search"
            data-testid="browser-history-search"
            value={searchInput}
            aria-label={t('workbench.browser_history_search')}
            placeholder={t('workbench.browser_history_search')}
            onChange={event => setSearchInput(event.target.value)}
            className="h-9 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:bg-background"
          />
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">
          {t('workbench.browser_history_all_time')}
        </h2>
        <div className="flex items-center gap-2">
          {selectedIds.length > 0 ? (
            <button
              type="button"
              data-testid="browser-history-remove-selected"
              disabled={removing}
              onClick={() => void removeEntries(selectedIds)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:opacity-50"
            >
              {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('workbench.browser_history_remove_selected')}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="browser-history-clear-data-button"
            disabled={removing || clearing}
            onClick={() => setClearDialogOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            {t('workbench.browser_settings_clear_action')}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-surface/70">
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
            <button
              type="button"
              data-testid="browser-history-pagination-retry-button"
              onClick={() => void loadNextPage()}
              className="h-8 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover"
            >
              {t('workbench.browser_history_retry')}
            </button>
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
      <TransientNotice message={notice} tone="error" onClear={() => setNotice(null)} />
    </div>
  )
}
