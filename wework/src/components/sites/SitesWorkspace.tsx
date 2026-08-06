import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { AlertCircle, Loader2, Plus, RefreshCw, Search } from 'lucide-react'
import { ApiError } from '@/api/http'
import { isSitesUnavailableError } from '@/api/sites'
import type { Site, SiteAppType, SiteListItem, SitesApi } from '@/api/sites'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import {
  DEFAULT_APPLICATION_TYPE,
  getApplicationTypeDefinition,
} from './applicationTypeDefinitions'
import { DeleteSiteDialog } from './DeleteSiteDialog'
import { useApplicationTypeDefinitions } from './useApplicationTypeDefinitions'

interface SitesWorkspaceProps {
  api: SitesApi
  onCreate: (appType: SiteAppType) => void | Promise<void>
  creatingType?: SiteAppType | null
  pageSize?: number
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  createError?: string | null
  onOpenPlugins?: () => void
}

interface ApplicationCollectionOptions {
  api: SitesApi
  appType: SiteAppType
  query: string
  pageSize: number
  loadFailedMessage: string
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function isSecurityCheckingError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.errorCode === 'SECURITY_CHECKING') return true
  const detail = recordValue(error.detail)
  const nestedError = recordValue(detail?.error)
  return detail?.code === 'SECURITY_CHECKING' || nestedError?.code === 'SECURITY_CHECKING'
}

function getInitialAppType(): SiteAppType {
  if (typeof window === 'undefined') return DEFAULT_APPLICATION_TYPE
  const requestedType = new URLSearchParams(window.location.search).get('app_type')
  return getApplicationTypeDefinition(requestedType ?? '')?.appType ?? DEFAULT_APPLICATION_TYPE
}

function useApplicationCollection({
  api,
  appType,
  query,
  pageSize,
  loadFailedMessage,
}: ApplicationCollectionOptions) {
  const [items, setItems] = useState<SiteListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const requestId = useRef(0)

  const loadFirstPage = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setLoadError(null)
    try {
      const response = await api.listSites({
        appType,
        q: query,
        offset: 0,
        limit: pageSize,
      })
      if (currentRequest !== requestId.current) return
      setItems(response.items.filter(item => item.app_type === appType))
      setTotal(response.total)
      setUnavailable(false)
    } catch (error) {
      if (currentRequest !== requestId.current) return
      setItems([])
      setTotal(0)
      if (isSitesUnavailableError(error)) {
        setUnavailable(true)
        setLoadError(null)
      } else {
        setUnavailable(false)
        setLoadError(errorMessage(error, loadFailedMessage))
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [api, appType, loadFailedMessage, pageSize, query])

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadFirstPage(), 0)
    return () => window.clearTimeout(timeout)
  }, [loadFirstPage])

  const loadMore = async () => {
    setLoadingMore(true)
    setLoadError(null)
    try {
      const response = await api.listSites({
        appType,
        q: query,
        offset: items.length,
        limit: pageSize,
      })
      setItems(current => [...current, ...response.items.filter(item => item.app_type === appType)])
      setTotal(response.total)
    } catch (error) {
      if (isSitesUnavailableError(error)) {
        setUnavailable(true)
        setItems([])
        setTotal(0)
        setLoadError(null)
      } else {
        setLoadError(errorMessage(error, loadFailedMessage))
      }
    } finally {
      setLoadingMore(false)
    }
  }

  return {
    items,
    setItems,
    total,
    setTotal,
    loading,
    loadingMore,
    loadError,
    unavailable,
    loadFirstPage,
    loadMore,
  }
}

function SitesCreateError({
  message,
  openPluginsLabel,
  onOpenPlugins,
}: {
  message: string
  openPluginsLabel: string
  onOpenPlugins?: () => void
}) {
  return (
    <div
      className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3"
      role="alert"
      data-testid="sites-create-error"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
        <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
        <span className="truncate">{message}</span>
      </span>
      {onOpenPlugins && (
        <button
          type="button"
          data-testid="sites-open-plugins-button"
          onClick={onOpenPlugins}
          className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-sm text-text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
        >
          {openPluginsLabel}
        </button>
      )}
    </div>
  )
}

export function SitesWorkspace({
  api,
  onCreate,
  creatingType = null,
  pageSize = 20,
  sidebarCollapsed = false,
  topBarLeftActions,
  createError,
  onOpenPlugins,
}: SitesWorkspaceProps) {
  const { t } = useTranslation('sites')
  const applicationTypes = useApplicationTypeDefinitions(api)
  const [activeAppType, setActiveAppType] = useState<SiteAppType>(getInitialAppType)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set())
  const [pendingDeleteSite, setPendingDeleteSite] = useState<Site | null>(null)
  const [deletingSiteId, setDeletingSiteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 180)
    return () => window.clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    const handlePopState = () => setActiveAppType(getInitialAppType())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const activeApplicationType =
    applicationTypes.find(item => item.definition.appType === activeAppType) ?? applicationTypes[0]
  const activeDefinition = activeApplicationType.definition
  const ActiveApplicationIcon = activeDefinition.icon
  const loadFailedMessage = t(activeDefinition.loadFailed.key, activeDefinition.loadFailed.fallback)
  const collection = useApplicationCollection({
    api,
    appType: activeAppType,
    query: debouncedQuery,
    pageSize,
    loadFailedMessage,
  })
  const items = collection.items.filter(activeDefinition.isItem)

  const selectAppType = useCallback((appType: SiteAppType) => {
    setActiveAppType(appType)
    setQuery('')
    setDebouncedQuery('')
    const url = new URL(window.location.href)
    url.searchParams.set('app_type', appType)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  useEffect(() => {
    if (activeDefinition.appType !== activeAppType) selectAppType(activeDefinition.appType)
  }, [activeAppType, activeDefinition.appType, selectAppType])

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const appTypes = applicationTypes.map(item => item.definition.appType)
    const currentIndex = appTypes.indexOf(activeAppType)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % appTypes.length
    if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + appTypes.length) % appTypes.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = appTypes.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextType = appTypes[nextIndex]
    selectAppType(nextType)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-app-type="${nextType}"]`)?.focus()
    })
  }

  const publish = async (site: Site) => {
    if (deletingSiteId === site.siteid) return
    const nextNetwork = site.network === 'outer' || site.external_url ? 'inner' : 'outer'
    setPublishingIds(current => new Set(current).add(site.siteid))
    collection.setItems(current =>
      current.map(item =>
        item.app_type === 'web' && item.siteid === site.siteid
          ? { ...item, publish_status: 'publishing', last_publish_error: null }
          : item
      )
    )
    try {
      const published = await api.updateSiteNetwork(site.siteid, nextNetwork)
      collection.setItems(current =>
        current.map(item => (item.siteid === site.siteid ? published : item))
      )
      track('feature_action_completed', { action: 'publish', domain: 'site' })
    } catch (error) {
      collection.setItems(current =>
        current.map(item =>
          item.app_type === 'web' && item.siteid === site.siteid
            ? isSecurityCheckingError(error)
              ? {
                  ...item,
                  publish_status: 'scanning',
                  last_publish_error: null,
                }
              : {
                  ...item,
                  publish_status: 'failed',
                  last_publish_error: errorMessage(error, t('publish_failed', '发布失败')),
                }
            : item
        )
      )
      track('operation_failed', { operation: 'site_action' })
    } finally {
      setPublishingIds(current => {
        const next = new Set(current)
        next.delete(site.siteid)
        return next
      })
    }
  }

  const deleteSite = async () => {
    if (!pendingDeleteSite || deletingSiteId) return
    setDeletingSiteId(pendingDeleteSite.siteid)
    setDeleteError(null)
    try {
      await api.deleteSite(pendingDeleteSite.siteid)
      collection.setItems(current =>
        current.filter(item => item.siteid !== pendingDeleteSite.siteid)
      )
      collection.setTotal(current => Math.max(0, current - 1))
      setPendingDeleteSite(null)
      track('feature_action_completed', { action: 'delete', domain: 'site' })
    } catch (error) {
      setDeleteError(errorMessage(error, t('delete_failed', '站点删除失败')))
      track('operation_failed', { operation: 'site_action' })
    } finally {
      setDeletingSiteId(null)
    }
  }

  const createItems = applicationTypes
    .filter(item => item.capabilities.has('create'))
    .map(({ definition }) => ({
      label: t(definition.create.label.key, definition.create.label.fallback),
      icon: definition.icon,
      testId: definition.create.testId,
      onSelect: () => onCreate(definition.appType),
    }))

  const emptyTitle = t(activeDefinition.emptyTitle.key, activeDefinition.emptyTitle.fallback)
  const emptyDescription = t(
    activeDefinition.emptyDescription.key,
    activeDefinition.emptyDescription.fallback
  )

  return (
    <main
      data-testid="sites-workspace"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <div className="sticky top-0 z-40 border-b border-transparent bg-background/95 backdrop-blur-xl">
        <div
          className={[
            'mx-auto flex h-12 max-w-[1420px] items-center justify-between pl-20 pr-5 md:h-[52px] md:pr-7',
            sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          ].join(' ')}
        >
          <div>{topBarLeftActions}</div>
          <div className="flex items-center gap-2">
            {!collection.unavailable ? (
              <button
                type="button"
                data-testid="sites-refresh-button"
                aria-label={t(activeDefinition.refresh.key, activeDefinition.refresh.fallback)}
                disabled={collection.loading}
                onClick={() => void collection.loadFirstPage()}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-wait disabled:opacity-60 md:h-8 md:w-8"
              >
                <RefreshCw
                  className={collection.loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
                  aria-hidden="true"
                />
              </button>
            ) : null}
            <ActionMenu
              ariaLabel={t('create_application', '创建应用')}
              testId="sites-create-button"
              items={createItems}
              icon={creatingType ? Loader2 : Plus}
              triggerLabel={t('create', '创建')}
              disabled={Boolean(creatingType)}
              placement="bottom-end"
              triggerClassName={[
                'flex h-11 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:cursor-wait disabled:opacity-60 md:h-8',
                creatingType ? '[&>svg:first-child]:animate-spin' : '',
              ].join(' ')}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[920px] flex-col px-5 pb-14 pt-5 md:px-8 md:pt-4">
        <section className="space-y-1.5">
          <h1 className="text-xl font-normal leading-9 text-text-primary">{t('title', '应用')}</h1>
          <p className="text-base leading-6 text-text-secondary md:text-lg">
            {t('subtitle', '创建、管理并发布你的应用')}
          </p>
        </section>

        <div
          className="mt-5 flex min-h-11 items-end gap-6 border-b border-border md:min-h-0"
          role="tablist"
          aria-label={t('application_types', '应用类型')}
        >
          {applicationTypes.map(({ definition }) => {
            const appType = definition.appType
            const selected = activeAppType === appType
            const label = t(definition.tab.key, definition.tab.fallback)
            return (
              <button
                key={appType}
                type="button"
                role="tab"
                data-app-type={appType}
                data-testid={`applications-tab-${appType.replaceAll('_', '-')}`}
                id={`applications-tab-${appType}`}
                aria-selected={selected}
                aria-controls="applications-tab-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => selectAppType(appType)}
                onKeyDown={handleTabKeyDown}
                className={[
                  'relative flex h-11 items-center px-0.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:h-8',
                  selected ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary',
                ].join(' ')}
              >
                {label}
                {selected ? (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
                ) : null}
              </button>
            )
          })}
        </div>

        <label className="relative mt-5 block">
          <span className="sr-only">
            {t(activeDefinition.search.key, activeDefinition.search.fallback)}
          </span>
          <Search
            className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            data-testid="sites-search-input"
            placeholder={t(activeDefinition.search.key, activeDefinition.search.fallback)}
            className="h-11 w-full rounded-full border border-border bg-background pl-10 pr-4 text-base text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/15 md:h-9"
          />
        </label>

        {createError && (
          <SitesCreateError
            message={createError}
            openPluginsLabel={t('open_plugins', '查看插件')}
            onOpenPlugins={onOpenPlugins}
          />
        )}

        <div
          id="applications-tab-panel"
          role="tabpanel"
          aria-labelledby={`applications-tab-${activeAppType}`}
          className="mt-8"
        >
          {!collection.unavailable ? (
            <div
              className={[
                'hidden gap-6 border-b border-border pb-3 text-xs text-text-muted md:grid',
                activeDefinition.columnGridClassName,
              ].join(' ')}
            >
              {activeDefinition.columns.map(column => (
                <span key={column.key}>{t(column.key, column.fallback)}</span>
              ))}
            </div>
          ) : null}

          {collection.loading ? (
            <div
              className="flex min-h-48 items-center justify-center text-text-secondary"
              aria-label={t(activeDefinition.loading.key, activeDefinition.loading.fallback)}
            >
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            </div>
          ) : collection.unavailable ? (
            <div
              data-testid="sites-unavailable-state"
              className="flex min-h-56 items-center justify-center text-center"
            >
              <p className="text-sm text-text-secondary">{t('unavailable', '应用功能尚未推出')}</p>
            </div>
          ) : collection.loadError && items.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
              <AlertCircle className="h-6 w-6 text-danger" aria-hidden="true" />
              <p className="text-sm text-text-secondary" role="alert">
                {collection.loadError}
              </p>
              <button
                type="button"
                data-testid="sites-retry-button"
                onClick={() => void collection.loadFirstPage()}
                className="h-11 rounded-lg border border-border px-3 text-sm hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:h-8"
              >
                {t('retry', '重试')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <ActiveApplicationIcon className="h-7 w-7 text-text-muted" aria-hidden="true" />
              <h2 className="mt-4 text-base font-medium">{emptyTitle}</h2>
              <p className="mt-1 text-sm text-text-secondary">{emptyDescription}</p>
            </div>
          ) : (
            <div>
              {items.map(item => (
                <div key={item.siteid}>
                  {activeDefinition.renderRow(item, {
                    capabilities: activeApplicationType.capabilities,
                    publishingIds,
                    deletingSiteId,
                    onPublish: publish,
                    onDelete: siteToDelete => {
                      setDeleteError(null)
                      setPendingDeleteSite(siteToDelete)
                    },
                  })}
                </div>
              ))}
            </div>
          )}

          {collection.loadError && items.length > 0 && (
            <p className="mt-3 text-center text-sm text-danger" role="alert">
              {collection.loadError}
            </p>
          )}
          {items.length < collection.total && (
            <div className="flex justify-center pt-5">
              <button
                type="button"
                data-testid="sites-load-more-button"
                disabled={collection.loadingMore}
                onClick={() => void collection.loadMore()}
                className="flex h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm text-text-primary transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-wait disabled:opacity-60 md:h-8"
              >
                {collection.loadingMore && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                )}
                {t('load_more', '加载更多')}
              </button>
            </div>
          )}
        </div>
      </div>
      {pendingDeleteSite && (
        <DeleteSiteDialog
          site={pendingDeleteSite}
          loading={deletingSiteId === pendingDeleteSite.siteid}
          error={deleteError}
          onCancel={() => {
            if (deletingSiteId) return
            setDeleteError(null)
            setPendingDeleteSite(null)
          }}
          onConfirm={() => void deleteSite()}
        />
      )}
    </main>
  )
}
