import { ApiError } from '@/api/http'
import type { Site, SiteAppType, SitesApi } from '@/api/sites'
import { ActionMenu } from '@/components/common/ActionMenu'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useTranslation } from '@/hooks/useTranslation'
import { replaceTo } from '@/lib/navigation'
import { track } from '@/telemetry/client'
import { TabsList, TabsRoot, TabsTab } from '@wegent/collaboration/controls/Tabs'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { AlertCircle, Boxes, Loader2, Plus, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createApplicationCollection } from './applicationCollection'
import { ApplicationContextToolbar } from './ApplicationContextToolbar'
import {
  DEFAULT_APPLICATION_TYPE,
  getApplicationTypeDefinition,
  type ApplicationCreateStrategy,
} from './applicationTypeDefinitions'
import { DeleteSiteDialog } from './DeleteSiteDialog'
import { EditSiteDialog } from './EditSiteDialog'
import { EnvironmentVariablesDialog } from './EnvironmentVariablesDialog'
import { SiteAccessDialog } from './SiteAccessDialog'
import { SiteAnalyticsDialog } from './SiteAnalyticsDialog'
import { SiteCollaboratorsDialog } from './SiteCollaboratorsDialog'
import { useApplicationTypeDefinitions } from './useApplicationTypeDefinitions'

interface SitesWorkspaceProps {
  api: SitesApi
  search: string
  onCreate: (appType: SiteAppType, create: ApplicationCreateStrategy) => void | Promise<void>
  onContinueDevelopment?: (site: Site, create: ApplicationCreateStrategy) => void | Promise<void>
  creatingType?: SiteAppType | null
  continuingSiteId?: string | null
  pageSize?: number
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  createError?: string | null
  createNotice?: string | null
  onOpenPlugins?: () => void
  smartAppsContent?: ReactNode
  smartAppsEnabled?: boolean
}

type ApplicationWorkspaceType = SiteAppType | 'smart_app'

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

function getAppType(search: string, smartAppsEnabled: boolean): ApplicationWorkspaceType {
  const requestedType = new URLSearchParams(search).get('app_type')
  if (smartAppsEnabled && (!requestedType || requestedType === 'smart_app')) return 'smart_app'
  return getApplicationTypeDefinition(requestedType ?? '')?.appType ?? DEFAULT_APPLICATION_TYPE
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
        <ControlButton
          variant="outline"
          size="sm"
          type="button"
          data-testid="sites-open-plugins-button"
          onClick={onOpenPlugins}
          className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-sm text-text-primary hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
        >
          {openPluginsLabel}
        </ControlButton>
      )}
    </div>
  )
}

function SitesCreateNotice({ message }: { message: string }) {
  return (
    <div
      className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-secondary"
      role="status"
      aria-live="polite"
      data-testid="sites-create-notice"
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-muted" aria-hidden="true" />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  )
}

export function SitesWorkspace({
  api,
  search,
  onCreate,
  onContinueDevelopment,
  creatingType = null,
  continuingSiteId = null,
  pageSize = 20,
  sidebarCollapsed = false,
  topBarLeftActions,
  createError,
  createNotice,
  onOpenPlugins,
  smartAppsContent,
  smartAppsEnabled = false,
}: SitesWorkspaceProps) {
  const { t } = useTranslation('sites')
  const applicationTypes = useApplicationTypeDefinitions(api)
  const requestedAppType = getAppType(search, smartAppsEnabled)
  const activeAppType =
    requestedAppType === 'smart_app'
      ? requestedAppType
      : (applicationTypes.find(item => item.definition.appType === requestedAppType)?.definition
          .appType ?? applicationTypes[0].definition.appType)
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set())
  const [pendingDeleteSite, setPendingDeleteSite] = useState<Site | null>(null)
  const [deletingSiteId, setDeletingSiteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [pendingEditSite, setPendingEditSite] = useState<Site | null>(null)
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [pendingEnvironmentSite, setPendingEnvironmentSite] = useState<Site | null>(null)
  const [pendingCollaboratorsSite, setPendingCollaboratorsSite] = useState<Site | null>(null)
  const [pendingAnalyticsSite, setPendingAnalyticsSite] = useState<Site | null>(null)
  const [pendingAccessSite, setPendingAccessSite] = useState<Site | null>(null)

  const smartAppsActive = smartAppsEnabled && activeAppType === 'smart_app'
  const pageTitle = t('title', '应用')
  const pageDescription = t('subtitle', '创建、管理并发布你的应用')
  const activeSiteAppType = activeAppType === 'smart_app' ? DEFAULT_APPLICATION_TYPE : activeAppType
  const activeApplicationType =
    applicationTypes.find(item => item.definition.appType === activeSiteAppType) ??
    applicationTypes[0]
  const activeDefinition = activeApplicationType.definition
  const ActiveApplicationIcon = activeDefinition.icon
  const loadFailedMessage = t(activeDefinition.loadFailed.key, activeDefinition.loadFailed.fallback)
  const resource = useMemo(
    () => createApplicationCollection(api, activeSiteAppType, pageSize, !smartAppsActive),
    [api, activeSiteAppType, pageSize, smartAppsActive]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const collection = {
    ...snapshot,
    ...resource,
    loadError: snapshot.failure ? errorMessage(snapshot.failure.cause, loadFailedMessage) : null,
  }
  const items = collection.items.filter(activeDefinition.isItem)
  const routeParams = new URLSearchParams(search)
  const environmentProjectId =
    routeParams.get('view') === 'environment-variables' ? routeParams.get('project_id') : null
  const routeEnvironmentSite = items.find(
    item =>
      Boolean(environmentProjectId) &&
      item.app_type === 'web' &&
      (item.project_id === environmentProjectId || item.siteid === environmentProjectId)
  )
  const environmentSite =
    pendingEnvironmentSite ??
    (routeEnvironmentSite?.app_type === 'web' ? routeEnvironmentSite : null)
  const closeEnvironment = () => {
    setPendingEnvironmentSite(null)
    if (!environmentProjectId) return
    routeParams.delete('view')
    routeParams.delete('project_id')
    replaceTo(`/sites?${routeParams.toString()}`)
  }

  const selectAppType = useCallback(
    (appType: ApplicationWorkspaceType) => {
      if (appType === activeAppType) resource.resetSearch()
      const params = new URLSearchParams(window.location.search)
      params.set('app_type', appType)
      params.delete('view')
      params.delete('action')
      replaceTo(`/sites?${params.toString()}`)
    },
    [activeAppType, resource]
  )

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
      collection.removeSite(pendingDeleteSite.siteid)
      setPendingDeleteSite(null)
      track('feature_action_completed', { action: 'delete', domain: 'site' })
    } catch (error) {
      setDeleteError(errorMessage(error, t('delete_failed', '站点删除失败')))
      track('operation_failed', { operation: 'site_action' })
    } finally {
      setDeletingSiteId(null)
    }
  }

  const editSite = async (input: { title: string; customDomainPrefix: string | null }) => {
    if (!pendingEditSite || editingSiteId) return
    setEditingSiteId(pendingEditSite.siteid)
    setEditError(null)
    try {
      const updated = await api.updateSite(pendingEditSite.siteid, input)
      collection.setItems(current =>
        current.map(item => (item.siteid === pendingEditSite.siteid ? updated : item))
      )
      setPendingEditSite(null)
      track('feature_action_completed', { action: 'edit', domain: 'site' })
    } catch (error) {
      setEditError(errorMessage(error, t('edit_failed', '站点保存失败')))
      track('operation_failed', { operation: 'site_action' })
    } finally {
      setEditingSiteId(null)
    }
  }

  const createItems = applicationTypes
    .filter(item => item.capabilities.has('create'))
    .map(({ definition }) => ({
      label: t(definition.create.label.key, definition.create.label.fallback),
      icon: definition.icon,
      testId: definition.create.testId,
      onSelect: () => onCreate(definition.appType, definition.create),
    }))

  const emptyTitle = t(activeDefinition.emptyTitle.key, activeDefinition.emptyTitle.fallback)
  const emptyDescription = t(
    activeDefinition.emptyDescription.key,
    activeDefinition.emptyDescription.fallback
  )
  const unavailableTitle = t(
    activeDefinition.unavailableTitle.key,
    activeDefinition.unavailableTitle.fallback
  )
  const unavailableDescription = t(
    activeDefinition.unavailableDescription.key,
    activeDefinition.unavailableDescription.fallback
  )

  return (
    <main
      data-testid="sites-workspace"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <div className="sticky top-0 z-40 border-b border-transparent bg-background/95 backdrop-blur-xl">
        <div
          className={[
            'mx-auto flex h-12 max-w-[1420px] items-center pl-20 pr-5 md:h-[52px] md:pr-7',
            sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          ].join(' ')}
        >
          <div>{topBarLeftActions}</div>
        </div>
      </div>

      <div
        data-testid="applications-content"
        className="relative mx-auto flex w-full max-w-[1120px] flex-col px-5 pb-14 pt-5 md:px-8 md:pt-4"
      >
        <section className="flex min-h-16 flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5">
            <h1 className="text-xl font-normal leading-9 text-text-primary">{pageTitle}</h1>
            <p className="text-base leading-6 text-text-secondary md:text-lg">{pageDescription}</p>
          </div>
          {!smartAppsActive ? (
            <div
              data-testid="applications-page-header-actions"
              className="flex shrink-0 items-center gap-2 md:pt-1"
            >
              {!collection.unavailable ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="sites-refresh-button"
                  aria-label={t(activeDefinition.refresh.key, activeDefinition.refresh.fallback)}
                  disabled={collection.loading}
                  onClick={() => void collection.loadFirstPage()}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 disabled:cursor-wait disabled:opacity-60 md:h-9 md:w-9"
                >
                  <RefreshCw
                    className={collection.loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
                    aria-hidden="true"
                  />
                </ControlButton>
              ) : null}
              <ActionMenu
                density="default"
                ariaLabel={t('create_application', '创建应用')}
                testId="sites-create-button"
                items={createItems}
                icon={creatingType ? Loader2 : Plus}
                triggerLabel={t('create', '创建')}
                disabled={Boolean(creatingType)}
                placement="bottom-end"
                triggerClassName={[
                  'flex items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:cursor-wait',
                  creatingType ? '[&>svg:first-child]:animate-spin' : '',
                ].join(' ')}
              />
            </div>
          ) : null}
        </section>

        <TabsRoot
          value={smartAppsActive ? 'smart_app' : activeAppType}
          onValueChange={next => {
            if (next) selectAppType(next)
          }}
          render={<div className="contents" />}
        >
          <TabsList
            className="mt-5 flex min-h-11 items-end gap-6 border-b border-border md:min-h-0"
            aria-label={t('application_types', '应用类型')}
          >
            {smartAppsEnabled ? (
              <TabsTab
                value={'smart_app'}
                type="button"
                data-app-type="smart_app"
                data-testid="applications-tab-smart-app"
                id="applications-tab-smart-app"
                aria-controls="applications-tab-panel"
                className={[
                  'relative flex h-11 items-center gap-1.5 px-0.5 text-sm font-medium transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:h-8',
                  smartAppsActive
                    ? 'text-text-primary'
                    : 'text-text-muted hover:text-text-secondary',
                ].join(' ')}
              >
                <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
                {t('smart_apps_tab', '智能工作台')}
                <ExperimentalBadge testId="applications-smart-app-experimental-badge" />
                {smartAppsActive ? (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
                ) : null}
              </TabsTab>
            ) : null}
            {applicationTypes.map(({ definition }) => {
              const appType = definition.appType
              const selected = activeAppType === appType
              const label = t(definition.tab.key, definition.tab.fallback)
              return (
                <TabsTab
                  value={appType}
                  key={appType}
                  type="button"
                  data-app-type={appType}
                  data-testid={`applications-tab-${appType.replaceAll('_', '-')}`}
                  id={`applications-tab-${appType}`}
                  aria-controls="applications-tab-panel"
                  className={[
                    'relative flex h-11 items-center px-0.5 text-sm font-medium transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:h-8',
                    selected ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary',
                  ].join(' ')}
                >
                  {label}
                  {selected ? (
                    <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
                  ) : null}
                </TabsTab>
              )
            })}
          </TabsList>
        </TabsRoot>

        {smartAppsActive ? (
          <div
            id="applications-tab-panel"
            role="tabpanel"
            aria-labelledby="applications-tab-smart-app"
            className="mt-4"
            data-testid="applications-smart-app-panel"
          >
            {smartAppsContent}
          </div>
        ) : (
          <>
            <ApplicationContextToolbar
              className="mt-4"
              searchLabel={t(activeDefinition.search.key, activeDefinition.search.fallback)}
              searchPlaceholder={t(activeDefinition.search.key, activeDefinition.search.fallback)}
              searchTestId="sites-search-input"
              value={collection.searchInput}
              onValueChange={collection.changeSearch}
            />

            {createError && (
              <SitesCreateError
                message={createError}
                openPluginsLabel={t('open_plugins', '查看插件')}
                onOpenPlugins={onOpenPlugins}
              />
            )}
            {!createError && createNotice && <SitesCreateNotice message={createNotice} />}

            <div
              id="applications-tab-panel"
              role="tabpanel"
              aria-labelledby={`applications-tab-${activeAppType}`}
              className="mt-5"
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
                  className="flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-border/45 bg-background px-8 text-center"
                >
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/40 bg-surface/25 text-text-secondary">
                    <ActiveApplicationIcon className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <h2 className="mt-5 text-base font-medium text-text-primary">
                    {unavailableTitle}
                  </h2>
                  <p className="mt-2 max-w-md text-sm leading-6 text-text-secondary">
                    {unavailableDescription}
                  </p>
                </div>
              ) : collection.loadError && items.length === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
                  <AlertCircle className="h-6 w-6 text-danger" aria-hidden="true" />
                  <p className="text-sm text-text-secondary" role="alert">
                    {collection.loadError}
                  </p>
                  <ControlButton
                    variant="outline"
                    size="sm"
                    type="button"
                    data-testid="sites-retry-button"
                    onClick={() => void collection.loadFirstPage()}
                    className="h-11 rounded-lg border border-border px-3 text-sm hover:bg-surface focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:h-8"
                  >
                    {t('retry', '重试')}
                  </ControlButton>
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
                        continuingSiteId,
                        onPublish: publish,
                        onContinueDevelopment: siteToContinue =>
                          onContinueDevelopment?.(siteToContinue, activeDefinition.create),
                        onEdit: siteToEdit => {
                          setEditError(null)
                          setPendingEditSite(siteToEdit)
                        },
                        onConfigureEnvironment: setPendingEnvironmentSite,
                        onManageCollaborators: setPendingCollaboratorsSite,
                        onManageAccess: setPendingAccessSite,
                        onViewAnalytics: setPendingAnalyticsSite,
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
                  <ControlButton
                    variant="outline"
                    size="sm"
                    type="button"
                    data-testid="sites-load-more-button"
                    disabled={collection.loadingMore}
                    onClick={() => void collection.loadMore()}
                    className="flex h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm text-text-primary transition-colors hover:bg-surface focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 disabled:cursor-wait disabled:opacity-60 md:h-8"
                  >
                    {collection.loadingMore && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    )}
                    {t('load_more', '加载更多')}
                  </ControlButton>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {pendingAnalyticsSite && (
        <SiteAnalyticsDialog
          key={pendingAnalyticsSite.siteid}
          api={api}
          site={pendingAnalyticsSite}
          onClose={() => setPendingAnalyticsSite(null)}
        />
      )}
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
      {pendingEditSite && (
        <EditSiteDialog
          site={pendingEditSite}
          loading={editingSiteId === pendingEditSite.siteid}
          error={editError}
          onCancel={() => {
            if (editingSiteId) return
            setEditError(null)
            setPendingEditSite(null)
          }}
          onConfirm={input => void editSite(input)}
        />
      )}
      {environmentSite && (
        <EnvironmentVariablesDialog api={api} site={environmentSite} onClose={closeEnvironment} />
      )}
      {pendingCollaboratorsSite && (
        <SiteCollaboratorsDialog
          api={api}
          site={pendingCollaboratorsSite}
          onClose={() => setPendingCollaboratorsSite(null)}
        />
      )}
      {pendingAccessSite && (
        <SiteAccessDialog
          api={api}
          site={pendingAccessSite}
          onClose={() => setPendingAccessSite(null)}
        />
      )}
    </main>
  )
}
