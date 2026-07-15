import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertCircle,
  Check,
  ExternalLink,
  Globe2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react'
import type { Site, SitesApi } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'

interface SitesWorkspaceProps {
  api: SitesApi
  username: string
  onCreate: () => void
  pageSize?: number
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  createError?: string | null
  onOpenPlugins?: () => void
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function SiteThumbnail({ site }: { site: Site }) {
  const [imageFailed, setImageFailed] = useState(false)

  return (
    <div className="flex h-[50px] w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface">
      {site.thumbnail_url && !imageFailed ? (
        <img
          src={site.thumbnail_url}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <Globe2 className="h-5 w-5 text-text-muted" aria-hidden="true" />
      )}
    </div>
  )
}

interface SiteRowProps {
  site: Site
  publishing: boolean
  onPublish: (site: Site) => void
}

function SiteRow({ site, publishing, onPublish }: SiteRowProps) {
  const { t } = useTranslation('sites')
  const isPublished = site.publish_status === 'published'
  const isPublishing = publishing || site.publish_status === 'publishing'
  const isFailed = site.publish_status === 'failed'

  const openUrl = (url: string) => {
    void openExternalUrl(url).catch(error => {
      console.error('Failed to open site URL:', error)
    })
  }

  return (
    <article
      data-testid={`site-row-${site.siteid}`}
      className="grid gap-4 border-b border-border py-4 md:grid-cols-[minmax(0,1fr)_minmax(240px,0.55fr)] md:items-center md:gap-8"
    >
      <div className="flex min-w-0 items-center gap-4">
        <SiteThumbnail site={site} />
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-medium leading-5 text-text-primary">
            {site.name}
          </h2>
          <button
            type="button"
            data-testid={`site-internal-url-${site.siteid}`}
            aria-label={t('open_internal', { name: site.name })}
            onClick={() => openUrl(site.internal_url)}
            className="mt-1 flex max-w-full items-center gap-1 text-left text-[13px] leading-5 text-text-secondary transition-colors hover:text-text-primary"
          >
            <span className="truncate">{site.internal_url}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-4 pl-24 md:pl-0">
        <div className="min-w-0 flex-1" aria-live="polite">
          {site.external_url ? (
            <button
              type="button"
              data-testid={`site-external-url-${site.siteid}`}
              aria-label={t('open_external', { name: site.name })}
              onClick={() => openUrl(site.external_url!)}
              className="flex max-w-full items-center gap-1 text-left text-[13px] leading-5 text-text-secondary transition-colors hover:text-text-primary"
            >
              <span className="truncate">{site.external_url}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
          ) : isFailed ? (
            <span className="flex items-center gap-1.5 text-[13px] text-danger">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {site.last_publish_error || t('publish_failed', '发布失败')}
              </span>
            </span>
          ) : (
            <span className="text-[13px] text-text-muted">—</span>
          )}
        </div>
        <button
          type="button"
          data-testid={`site-publish-${site.siteid}`}
          disabled={isPublished || isPublishing}
          onClick={() => onPublish(site)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface disabled:cursor-default disabled:text-text-secondary disabled:opacity-70"
        >
          {isPublishing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : isPublished ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isPublishing
            ? t('publishing', '发布中')
            : isPublished
              ? t('published', '已发布')
              : isFailed
                ? t('retry_publish', '重试发布')
                : t('publish', '发布到外网')}
        </button>
      </div>
    </article>
  )
}

export function SitesWorkspace({
  api,
  username,
  onCreate,
  pageSize = 20,
  sidebarCollapsed = false,
  topBarLeftActions,
  createError,
  onOpenPlugins,
}: SitesWorkspaceProps) {
  const { t } = useTranslation('sites')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sites, setSites] = useState<Site[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set())
  const requestId = useRef(0)

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 180)
    return () => window.clearTimeout(timeout)
  }, [query])

  const loadFirstPage = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setLoadError(null)
    try {
      const response = await api.listSites({
        username,
        q: debouncedQuery,
        offset: 0,
        limit: pageSize,
      })
      if (currentRequest !== requestId.current) return
      setSites(response.items)
      setTotal(response.total)
    } catch (error) {
      if (currentRequest !== requestId.current) return
      setSites([])
      setTotal(0)
      setLoadError(errorMessage(error, t('load_failed', '站点加载失败')))
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [api, debouncedQuery, pageSize, t, username])

  useEffect(() => {
    void loadFirstPage()
  }, [loadFirstPage])

  const loadMore = async () => {
    setLoadingMore(true)
    setLoadError(null)
    try {
      const response = await api.listSites({
        username,
        q: debouncedQuery,
        offset: sites.length,
        limit: pageSize,
      })
      setSites(current => [...current, ...response.items])
      setTotal(response.total)
    } catch (error) {
      setLoadError(errorMessage(error, t('load_failed', '站点加载失败')))
    } finally {
      setLoadingMore(false)
    }
  }

  const publish = async (site: Site) => {
    setPublishingIds(current => new Set(current).add(site.siteid))
    setSites(current =>
      current.map(item =>
        item.siteid === site.siteid
          ? { ...item, publish_status: 'publishing', last_publish_error: null }
          : item
      )
    )
    try {
      const published = await api.publishSite(site.siteid)
      setSites(current => current.map(item => (item.siteid === site.siteid ? published : item)))
    } catch (error) {
      setSites(current =>
        current.map(item =>
          item.siteid === site.siteid
            ? {
                ...item,
                publish_status: 'failed',
                last_publish_error: errorMessage(error, t('publish_failed', '发布失败')),
              }
            : item
        )
      )
    } finally {
      setPublishingIds(current => {
        const next = new Set(current)
        next.delete(site.siteid)
        return next
      })
    }
  }

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
            <button
              type="button"
              data-testid="sites-refresh-button"
              aria-label={t('refresh', '刷新站点')}
              disabled={loading}
              onClick={() => void loadFirstPage()}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </button>
            <button
              type="button"
              data-testid="sites-create-button"
              onClick={onCreate}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('create', '创建')}
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[920px] flex-col px-5 pb-14 pt-5 md:px-8 md:pt-4">
        <section className="space-y-1.5">
          <h1 className="text-[30px] font-normal leading-9 text-text-primary">
            {t('title', '站点')}
          </h1>
          <p className="text-[16px] leading-6 text-text-secondary">
            {t('subtitle', '将你的想法变成真实网站')}
          </p>
        </section>

        <label className="relative mt-5 block">
          <span className="sr-only">{t('search', '搜索站点')}</span>
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            data-testid="sites-search-input"
            placeholder={t('search', '搜索站点')}
            className="h-9 w-full rounded-full border border-border bg-background pl-10 pr-4 text-[14px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-text-muted"
          />
        </label>

        {createError && (
          <div
            className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3"
            role="alert"
            data-testid="sites-create-error"
          >
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-text-secondary">
              <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <span className="truncate">{createError}</span>
            </span>
            {onOpenPlugins && (
              <button
                type="button"
                data-testid="sites-open-plugins-button"
                onClick={onOpenPlugins}
                className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-[13px] text-text-primary hover:bg-muted"
              >
                {t('open_plugins', '查看插件')}
              </button>
            )}
          </div>
        )}

        <div className="mt-8">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(240px,0.55fr)] gap-8 border-b border-border px-0 pb-3 text-[12px] text-text-muted md:grid">
            <span>{t('site_column', '站点')}</span>
            <span>{t('external_column', '外网发布')}</span>
          </div>

          {loading ? (
            <div
              className="flex min-h-48 items-center justify-center text-text-secondary"
              aria-label={t('loading', '正在加载站点')}
            >
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : loadError && sites.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
              <AlertCircle className="h-6 w-6 text-danger" aria-hidden="true" />
              <p className="text-sm text-text-secondary" role="alert">
                {loadError}
              </p>
              <button
                type="button"
                data-testid="sites-retry-button"
                onClick={() => void loadFirstPage()}
                className="h-8 rounded-lg border border-border px-3 text-[13px] hover:bg-surface"
              >
                {t('retry', '重试')}
              </button>
            </div>
          ) : sites.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <Globe2 className="h-7 w-7 text-text-muted" aria-hidden="true" />
              <h2 className="mt-4 text-[15px] font-medium">{t('empty_title', '还没有站点')}</h2>
              <p className="mt-1 text-[13px] text-text-secondary">
                {t('empty_description', '通过 Sites 创建你的第一个站点')}
              </p>
            </div>
          ) : (
            <div>
              {sites.map(site => (
                <SiteRow
                  key={site.siteid}
                  site={site}
                  publishing={publishingIds.has(site.siteid)}
                  onPublish={publish}
                />
              ))}
            </div>
          )}

          {loadError && sites.length > 0 && (
            <p className="mt-3 text-center text-[13px] text-danger" role="alert">
              {loadError}
            </p>
          )}
          {sites.length < total && (
            <div className="flex justify-center pt-5">
              <button
                type="button"
                data-testid="sites-load-more-button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-[13px] text-text-primary transition-colors hover:bg-surface disabled:cursor-wait disabled:opacity-60"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('load_more', '加载更多')}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
