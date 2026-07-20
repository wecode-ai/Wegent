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
import { isSitesUnavailableError } from '@/api/sites'
import type { SiteProject, SitesApi } from '@/api/sites'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { DeleteSiteDialog } from './DeleteSiteDialog'
import { SiteActionsMenu } from './SiteActionsMenu'

interface SitesWorkspaceProps {
  api: SitesApi
  onCreate: () => void | Promise<void>
  creating?: boolean
  pageSize?: number
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  createError?: string | null
  onOpenPlugins?: () => void
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

interface VersionedProject {
  project: SiteProject
  generation: number
}

function retireProjectMutations(
  generation: number,
  projectOverrides: Map<string, VersionedProject>,
  deletedProjectIds: Map<string, number>
) {
  for (const [projectId, override] of projectOverrides) {
    if (override.generation < generation) projectOverrides.delete(projectId)
  }
  for (const [projectId, deletedGeneration] of deletedProjectIds) {
    if (deletedGeneration < generation) deletedProjectIds.delete(projectId)
  }
}

function reconcileSiteProjects(
  projects: SiteProject[],
  generation: number,
  projectOverrides: ReadonlyMap<string, VersionedProject>,
  deletedProjectIds: ReadonlyMap<string, number>
): SiteProject[] {
  const seenIds = new Set<string>()
  const reconciledProjects = projects.flatMap(project => {
    const deletedGeneration = deletedProjectIds.get(project.id)
    if (
      (deletedGeneration !== undefined && generation <= deletedGeneration) ||
      seenIds.has(project.id)
    ) {
      return []
    }
    seenIds.add(project.id)
    const override = projectOverrides.get(project.id)
    return [override && generation <= override.generation ? override.project : project]
  })

  return reconciledProjects
}

function reconcilePublishErrors(
  current: Record<string, string>,
  projects: SiteProject[],
  replaceAll: boolean
): Record<string, string> {
  const projectsById = new Map(projects.map(project => [project.id, project]))
  let changed = false
  const next: Record<string, string> = {}

  for (const [projectId, message] of Object.entries(current)) {
    const project = projectsById.get(projectId)
    if ((replaceAll && !project) || project?.network === 'outer') {
      changed = true
    } else {
      next[projectId] = message
    }
  }

  return changed ? next : current
}

function SiteThumbnail({ site }: { site: SiteProject }) {
  const [failedSnapshot, setFailedSnapshot] = useState<string | null>(null)
  const imageFailed = failedSnapshot === site.snapshot

  return (
    <div className="flex h-[50px] w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface">
      {site.snapshot && !imageFailed ? (
        <img
          src={site.snapshot}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedSnapshot(site.snapshot)}
        />
      ) : (
        <Globe2 className="h-5 w-5 text-text-muted" aria-hidden="true" />
      )}
    </div>
  )
}

interface SiteRowProps {
  site: SiteProject
  publishing: boolean
  deleting: boolean
  renaming: boolean
  publishError?: string
  onPublish: (site: SiteProject) => void
  onRename: (site: SiteProject) => void
  onDelete: (site: SiteProject, returnFocusContainer: HTMLElement | null) => void
}

function SiteRow({
  site,
  publishing,
  deleting,
  renaming,
  publishError,
  onPublish,
  onRename,
  onDelete,
}: SiteRowProps) {
  const { t } = useTranslation('sites')
  const isOuter = site.network === 'outer'

  const openUrl = (url: string) => {
    void openExternalUrl(url).catch(error => {
      console.error('Failed to open site URL:', error)
    })
  }

  return (
    <article
      data-testid={`site-row-${site.id}`}
      className="grid gap-4 border-b border-border py-4 md:grid-cols-[minmax(0,1fr)_minmax(240px,0.55fr)] md:items-center md:gap-8"
    >
      <div className="flex min-w-0 items-center gap-4">
        <SiteThumbnail site={site} />
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium leading-5 text-text-primary">
            {site.title}
          </h2>
          <button
            type="button"
            data-testid={`site-url-${site.id}`}
            aria-label={t(isOuter ? 'open_external' : 'open_internal', { name: site.title })}
            onClick={() => openUrl(site.url)}
            className="mt-1 flex max-w-full items-center gap-1 text-left text-sm leading-5 text-text-secondary transition-colors hover:text-text-primary"
          >
            <span className="truncate">{site.url}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-4 pl-24 md:pl-0">
        <div className="min-w-0 flex-1" aria-live="polite">
          {publishError ? (
            <span className="flex items-center gap-1.5 text-sm text-danger" role="alert">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{publishError}</span>
            </span>
          ) : isOuter ? (
            <span
              data-testid={`site-published-${site.id}`}
              className="flex items-center gap-1.5 text-sm text-text-secondary"
            >
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t('published', '已发布')}
            </span>
          ) : (
            <span
              data-testid={`site-publish-placeholder-${site.id}`}
              className="text-sm text-text-muted"
            >
              —
            </span>
          )}
        </div>
        {!isOuter && (
          <button
            type="button"
            data-testid={`site-publish-${site.id}`}
            disabled={publishing || deleting || renaming}
            onClick={() => onPublish(site)}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface disabled:cursor-default disabled:text-text-secondary disabled:opacity-70 md:h-8"
          >
            {publishing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {publishing ? t('publishing', '发布中') : t('publish', '发布到外网')}
          </button>
        )}
        <SiteActionsMenu
          site={site}
          disabled={publishing || deleting || renaming}
          onRename={onRename}
          onDelete={onDelete}
        />
      </div>
    </article>
  )
}

export function SitesWorkspace({
  api,
  onCreate,
  creating = false,
  pageSize = 20,
  sidebarCollapsed = false,
  topBarLeftActions,
  createError,
  onOpenPlugins,
}: SitesWorkspaceProps) {
  const { t } = useTranslation('sites')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sites, setSites] = useState<SiteProject[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [nextCursorOwner, setNextCursorOwner] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sitesUnavailable, setSitesUnavailable] = useState(false)
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set())
  const [publishErrors, setPublishErrors] = useState<Record<string, string>>({})
  const [pendingRenameSite, setPendingRenameSite] = useState<SiteProject | null>(null)
  const [pendingDeleteSite, setPendingDeleteSite] = useState<SiteProject | null>(null)
  const [deletingSiteId, setDeletingSiteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const apiGeneration = useRef(0)
  const currentApi = useRef(api)
  const latestSites = useRef<SiteProject[]>([])
  const projectOverrides = useRef<Map<string, VersionedProject>>(new Map())
  const deletedProjectIds = useRef<Map<string, number>>(new Map())
  const publishingProjectIds = useRef<Set<string>>(new Set())
  const pendingRenameSiteId = useRef<string | null>(null)
  const renamingProjectId = useRef<string | null>(null)
  const pendingDeleteSiteId = useRef<string | null>(null)
  const deletingProjectId = useRef<string | null>(null)
  const deleteReturnFocusContainer = useRef<HTMLElement | null>(null)

  const replaceSites = useCallback((projects: SiteProject[]) => {
    latestSites.current = projects
    setSites(projects)
  }, [])

  const updateSites = useCallback((updater: (projects: SiteProject[]) => SiteProject[]) => {
    const projects = updater(latestSites.current)
    latestSites.current = projects
    setSites(projects)
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 180)
    return () => window.clearTimeout(timeout)
  }, [query])

  const loadFirstPage = useCallback(async () => {
    const generation = ++requestGeneration.current
    const requestQuery = debouncedQuery
    setLoading(true)
    setLoadingMore(false)
    setLoadError(null)
    try {
      const response = await api.listSites({
        q: requestQuery,
        cursor: null,
        limit: pageSize,
      })
      if (generation !== requestGeneration.current) return
      retireProjectMutations(generation, projectOverrides.current, deletedProjectIds.current)
      const projects = reconcileSiteProjects(
        response.items,
        generation,
        projectOverrides.current,
        deletedProjectIds.current
      )
      replaceSites(projects)
      setPublishErrors(current => reconcilePublishErrors(current, projects, true))
      setNextCursor(response.next_cursor)
      setNextCursorOwner(requestQuery)
      setSitesUnavailable(false)
    } catch (error) {
      if (generation !== requestGeneration.current) return
      if (isSitesUnavailableError(error)) {
        replaceSites([])
        setNextCursor(null)
        setNextCursorOwner(null)
        setSitesUnavailable(true)
        setLoadError(null)
      } else {
        setLoadError(errorMessage(error, t('load_failed', '站点加载失败')))
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [api, debouncedQuery, pageSize, replaceSites, t])

  useEffect(() => {
    if (currentApi.current === api) return

    currentApi.current = api
    apiGeneration.current += 1
    requestGeneration.current += 1
    projectOverrides.current.clear()
    deletedProjectIds.current.clear()
    publishingProjectIds.current.clear()
    pendingRenameSiteId.current = null
    renamingProjectId.current = null
    pendingDeleteSiteId.current = null
    deletingProjectId.current = null
    deleteReturnFocusContainer.current = null
    replaceSites([])
    setNextCursor(null)
    setNextCursorOwner(null)
    setLoading(true)
    setLoadingMore(false)
    setLoadError(null)
    setSitesUnavailable(false)
    setPublishingIds(new Set())
    setPublishErrors({})
    setPendingRenameSite(null)
    setPendingDeleteSite(null)
    setDeletingSiteId(null)
    setDeleteError(null)
  }, [api, replaceSites])

  useEffect(() => {
    void loadFirstPage()
  }, [loadFirstPage])

  const loadMore = async () => {
    if (loading || nextCursor === null || nextCursorOwner !== debouncedQuery) return
    const generation = requestGeneration.current
    const cursor = nextCursor
    const requestQuery = debouncedQuery
    setLoadingMore(true)
    setLoadError(null)
    try {
      const response = await api.listSites({
        q: requestQuery,
        cursor,
        limit: pageSize,
      })
      if (generation !== requestGeneration.current) return
      const projects = reconcileSiteProjects(
        response.items,
        generation,
        projectOverrides.current,
        deletedProjectIds.current
      )
      updateSites(current => {
        const knownIds = new Set(current.map(site => site.id))
        const newSites = projects.filter(site => {
          if (knownIds.has(site.id)) return false
          knownIds.add(site.id)
          return true
        })
        return [...current, ...newSites]
      })
      setPublishErrors(current => reconcilePublishErrors(current, projects, false))
      setNextCursor(response.next_cursor)
      setNextCursorOwner(requestQuery)
    } catch (error) {
      if (generation !== requestGeneration.current) return
      if (isSitesUnavailableError(error)) {
        setSitesUnavailable(true)
        replaceSites([])
        setNextCursor(null)
        setNextCursorOwner(null)
        setLoadError(null)
      } else {
        setLoadError(errorMessage(error, t('load_failed', '站点加载失败')))
      }
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false)
    }
  }

  const publish = async (site: SiteProject) => {
    if (
      site.network === 'outer' ||
      pendingRenameSiteId.current === site.id ||
      renamingProjectId.current === site.id ||
      pendingDeleteSiteId.current === site.id ||
      deletingProjectId.current === site.id ||
      publishingProjectIds.current.has(site.id)
    ) {
      return
    }
    publishingProjectIds.current.add(site.id)
    const operationApiGeneration = apiGeneration.current
    setPublishingIds(current => new Set(current).add(site.id))
    setPublishErrors(current => {
      if (!(site.id in current)) return current
      const next = { ...current }
      delete next[site.id]
      return next
    })
    try {
      const published = await api.publishSite(site.id)
      if (operationApiGeneration !== apiGeneration.current) return
      projectOverrides.current.set(site.id, {
        project: published,
        generation: requestGeneration.current,
      })
      updateSites(current => current.map(item => (item.id === site.id ? published : item)))
    } catch (error) {
      if (operationApiGeneration !== apiGeneration.current) return
      const latestProject = latestSites.current.find(project => project.id === site.id)
      if (latestProject?.network === 'outer') return
      setPublishErrors(current => ({
        ...current,
        [site.id]: errorMessage(error, t('publish_failed', '发布失败')),
      }))
    } finally {
      if (operationApiGeneration === apiGeneration.current) {
        publishingProjectIds.current.delete(site.id)
        setPublishingIds(current => {
          const next = new Set(current)
          next.delete(site.id)
          return next
        })
      }
    }
  }

  const openRenameDialog = (site: SiteProject) => {
    if (
      pendingRenameSiteId.current !== null ||
      renamingProjectId.current !== null ||
      pendingDeleteSiteId.current === site.id ||
      deletingProjectId.current === site.id ||
      publishingProjectIds.current.has(site.id)
    ) {
      return
    }
    pendingRenameSiteId.current = site.id
    setPendingRenameSite(site)
  }

  const cancelRename = () => {
    if (renamingProjectId.current) return
    pendingRenameSiteId.current = null
    setPendingRenameSite(null)
  }

  const renameSite = async (title: string) => {
    if (!pendingRenameSite) return
    const projectId = pendingRenameSite.id
    if (
      pendingRenameSiteId.current !== projectId ||
      renamingProjectId.current !== null ||
      pendingDeleteSiteId.current === projectId ||
      deletingProjectId.current === projectId ||
      publishingProjectIds.current.has(projectId)
    ) {
      return
    }

    renamingProjectId.current = projectId
    const operationApiGeneration = apiGeneration.current
    try {
      const renamed = await api.renameSite(projectId, title)
      if (operationApiGeneration !== apiGeneration.current) return
      projectOverrides.current.set(projectId, {
        project: renamed,
        generation: requestGeneration.current,
      })
      updateSites(current => current.map(item => (item.id === projectId ? renamed : item)))
      setPublishErrors(current => {
        if (!(projectId in current)) return current
        const next = { ...current }
        delete next[projectId]
        return next
      })
    } finally {
      if (operationApiGeneration === apiGeneration.current) {
        renamingProjectId.current = null
      }
    }
  }

  const openDeleteDialog = (site: SiteProject, returnFocusContainer: HTMLElement | null) => {
    if (
      pendingDeleteSiteId.current !== null ||
      pendingRenameSiteId.current === site.id ||
      renamingProjectId.current === site.id ||
      deletingProjectId.current === site.id ||
      publishingProjectIds.current.has(site.id)
    ) {
      return
    }
    pendingDeleteSiteId.current = site.id
    deleteReturnFocusContainer.current = returnFocusContainer
    setDeleteError(null)
    setPendingDeleteSite(site)
  }

  const cancelDelete = () => {
    if (deletingProjectId.current) return
    pendingDeleteSiteId.current = null
    setDeleteError(null)
    setPendingDeleteSite(null)
  }

  const deleteSite = async () => {
    if (!pendingDeleteSite) return
    const projectId = pendingDeleteSite.id
    if (
      pendingDeleteSiteId.current !== projectId ||
      deletingProjectId.current !== null ||
      pendingRenameSiteId.current === projectId ||
      renamingProjectId.current === projectId ||
      publishingProjectIds.current.has(projectId)
    ) {
      return
    }
    deletingProjectId.current = projectId
    const operationApiGeneration = apiGeneration.current
    setDeletingSiteId(projectId)
    setDeleteError(null)
    try {
      await api.deleteSite(projectId)
      if (operationApiGeneration !== apiGeneration.current) return
      deletedProjectIds.current.set(projectId, requestGeneration.current)
      projectOverrides.current.delete(projectId)
      updateSites(current => current.filter(item => item.id !== projectId))
      setPublishErrors(current => {
        if (!(projectId in current)) return current
        const next = { ...current }
        delete next[projectId]
        return next
      })
      pendingDeleteSiteId.current = null
      setPendingDeleteSite(null)
    } catch (error) {
      if (operationApiGeneration !== apiGeneration.current) return
      setDeleteError(errorMessage(error, t('delete_failed', '站点删除失败')))
    } finally {
      if (operationApiGeneration === apiGeneration.current) {
        deletingProjectId.current = null
        setDeletingSiteId(null)
      }
    }
  }

  if (sitesUnavailable) {
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
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[920px] flex-col px-5 pb-14 pt-5 md:px-8 md:pt-4">
          <section className="space-y-1.5">
            <h1 className="text-xl font-normal leading-9 text-text-primary">
              {t('title', '站点')}
            </h1>
            <p className="text-lg leading-6 text-text-secondary">
              {t('subtitle', '将你的想法变成真实网站')}
            </p>
          </section>
          <div
            data-testid="sites-unavailable-state"
            className="flex min-h-64 items-center justify-center text-center"
          >
            <p className="text-sm text-text-secondary">{t('unavailable', '站点功能尚未推出')}</p>
          </div>
        </div>
      </main>
    )
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
              disabled={creating}
              onClick={() => void onCreate()}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface disabled:cursor-wait disabled:opacity-60"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {t('create', '创建')}
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[920px] flex-col px-5 pb-14 pt-5 md:px-8 md:pt-4">
        <section className="space-y-1.5">
          <h1 className="text-xl font-normal leading-9 text-text-primary">{t('title', '站点')}</h1>
          <p className="text-lg leading-6 text-text-secondary">
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
            className="h-9 w-full rounded-full border border-border bg-background pl-10 pr-4 text-base text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-text-muted"
          />
        </label>

        {createError && (
          <div
            className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3"
            role="alert"
            data-testid="sites-create-error"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
              <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <span className="truncate">{createError}</span>
            </span>
            {onOpenPlugins && (
              <button
                type="button"
                data-testid="sites-open-plugins-button"
                onClick={onOpenPlugins}
                className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-sm text-text-primary hover:bg-muted"
              >
                {t('open_plugins', '查看插件')}
              </button>
            )}
          </div>
        )}

        <div className="mt-8">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(240px,0.55fr)] gap-8 border-b border-border px-0 pb-3 text-xs text-text-muted md:grid">
            <span>{t('site_column', '站点')}</span>
            <span>{t('external_column', '网络访问')}</span>
          </div>

          {loading && sites.length === 0 ? (
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
                className="h-8 rounded-lg border border-border px-3 text-sm hover:bg-surface"
              >
                {t('retry', '重试')}
              </button>
            </div>
          ) : sites.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <Globe2 className="h-7 w-7 text-text-muted" aria-hidden="true" />
              <h2 className="mt-4 text-base font-medium">{t('empty_title', '还没有站点')}</h2>
              <p className="mt-1 text-sm text-text-secondary">
                {t('empty_description', '通过 Sites 创建你的第一个站点')}
              </p>
            </div>
          ) : (
            <div>
              {sites.map(site => (
                <SiteRow
                  key={site.id}
                  site={site}
                  publishing={publishingIds.has(site.id)}
                  deleting={pendingDeleteSite?.id === site.id || deletingSiteId === site.id}
                  renaming={pendingRenameSite?.id === site.id}
                  publishError={publishErrors[site.id]}
                  onPublish={publish}
                  onRename={openRenameDialog}
                  onDelete={openDeleteDialog}
                />
              ))}
            </div>
          )}

          {loadError && sites.length > 0 && (
            <p className="mt-3 text-center text-sm text-danger" role="alert">
              {loadError}
            </p>
          )}
          {nextCursor !== null && (
            <div className="flex justify-center pt-5">
              <button
                type="button"
                data-testid="sites-load-more-button"
                disabled={loading || loadingMore || nextCursorOwner !== debouncedQuery}
                onClick={() => void loadMore()}
                className="flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-sm text-text-primary transition-colors hover:bg-surface disabled:cursor-wait disabled:opacity-60"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('load_more', '加载更多')}
              </button>
            </div>
          )}
        </div>
      </div>
      {pendingRenameSite && (
        <TextInputDialog
          open
          title={t('rename_title', '重命名站点')}
          label={t('rename_label', '站点名称')}
          description={t('rename_description', '输入便于识别的站点名称。')}
          initialValue={pendingRenameSite.title}
          confirmLabel={t('confirm_rename', '保存')}
          cancelLabel={t('cancel', '取消')}
          inputTestId="site-rename-input"
          confirmTestId="site-rename-confirm-button"
          maxLength={255}
          onClose={cancelRename}
          onSubmit={renameSite}
        />
      )}
      {pendingDeleteSite && (
        <DeleteSiteDialog
          site={pendingDeleteSite}
          loading={deletingSiteId === pendingDeleteSite.id}
          error={deleteError}
          returnFocusContainer={deleteReturnFocusContainer.current}
          onCancel={cancelDelete}
          onConfirm={() => void deleteSite()}
        />
      )}
    </main>
  )
}
