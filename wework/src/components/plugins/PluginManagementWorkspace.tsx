import { getToken } from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { getRuntimeConfig } from '@/config/runtime'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { INTERNAL_DEVICE_MARKETPLACE_ID } from '@/features/plugins/marketplaceIdentity'
import {
  createLocalDevicePluginApi,
  resolveLocalPluginDeviceRouteId,
} from '@/features/plugins/pluginDeviceApi'
import { createLocalFirstPluginApi } from '@/features/plugins/pluginLocalSync'
import { pluginMarketplaceCacheKey } from '@/features/plugins/pluginMarketplaceCache'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import { queuePluginTrial } from '@/features/plugins/pluginTrial'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import type { InstalledPlugin } from '@/types/api'
import { TabsList, TabsRoot, TabsTab } from '@wegent/collaboration/controls/Tabs'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { ReactNode } from 'react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { CoreDshPluginManagementSection } from './CoreDshPluginManagementSection'
import { findMarketplaceItemForInstalled } from './findMarketplaceItemForInstalled'
import {
  isCloudManagedInstalledPlugin,
  isWegentManagedStorePlugin,
  linkedCloudPluginId,
} from './installedPluginMerge'
import { UninstallPluginDialog } from './plugin-dialogs/UninstallPluginDialog'
import { pluginDetailReadyToTry } from './pluginDetailReadyToTry'
import { PluginDetailView } from './PluginDetailView'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from './pluginDistribution'
import type { InstalledPluginItem } from './PluginManagementRows'
import { InstalledPluginRow } from './PluginManagementRows'
import {
  createPluginManagementSource,
  findGitMarketplaceVersionHint,
  resolvePublishedPluginUpdate,
  type PluginManagementTab,
} from './pluginManagementSource'
import { PluginMarketplaceManagement } from './PluginMarketplaceManagement'
import { PluginOperationNotice } from './PluginOperationNotice'
import { resolvePluginOwnerActions } from './pluginOwnerActions'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from './pluginOwnerLocalPackage'

function tryPluginInChat(plugin: InstalledPlugin) {
  queuePluginTrial(plugin, { openInNewChat: true })
  navigateTo('/')
}

interface PluginManagementWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  cloudApiBaseUrl?: string
  cloudToken?: string | null
  onCreateWeworkPlugin?: () => Promise<void>
}

export function PluginManagementWorkspace(props: PluginManagementWorkspaceProps) {
  const cacheKey = pluginMarketplaceCacheKey(
    props.cloudApiBaseUrl || getRuntimeConfig().apiBaseUrl,
    props.cloudToken
  )
  const deviceId = isDesktopRuntime() ? getKnownLocalExecutorDeviceId() || '' : ''
  return <PluginManagementWorkspaceContent key={`${cacheKey}:${deviceId}`} {...props} />
}

function PluginManagementWorkspaceContent({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudApiBaseUrl,
  cloudToken,
  onCreateWeworkPlugin,
}: PluginManagementWorkspaceProps) {
  const { t } = useTranslation('common')

  const runtime = getRuntimeConfig()
  const resolvedCloudApiBaseUrl = cloudApiBaseUrl || runtime.apiBaseUrl
  const marketplaceCacheKeyValue = useMemo(
    () => pluginMarketplaceCacheKey(resolvedCloudApiBaseUrl, cloudToken),
    [cloudToken, resolvedCloudApiBaseUrl]
  )
  const knownDeviceId = isDesktopRuntime() ? getKnownLocalExecutorDeviceId() || '' : ''
  const cloudAvailable = Boolean(cloudToken === undefined ? getToken() : cloudToken)

  const showCoreDshTab = isElectronRuntime()
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const profile = {
      apiBaseUrl: resolvedCloudApiBaseUrl,
      token: cloudToken === undefined ? getToken() : cloudToken,
    }
    const api = createPluginApi(
      createHttpClient({
        baseUrl: profile.apiBaseUrl,
        getToken: () => profile.token,
        ...(cloudToken === undefined ? {} : { redirectOnUnauthorized: false }),
      }),
      resolvedCloudApiBaseUrl
    )
    const deviceApi = createLocalDevicePluginApi(api, deviceId =>
      resolveLocalPluginDeviceRouteId(deviceId, profile)
    )
    return {
      ...deviceApi,
      updatePublishedRelease: createLocalFirstPluginApi(api, deviceApi, profile)
        .updateInstalledPlugin,
    }
  }, [cloudToken, resolvedCloudApiBaseUrl])

  const workspaceSource = useMemo(
    () =>
      createPluginManagementSource({
        cacheKey: marketplaceCacheKeyValue,
        knownDeviceId,
        localPluginApi,
        cloudPluginApi,
        cloudAvailable,
      }),
    [marketplaceCacheKeyValue, knownDeviceId, localPluginApi, cloudPluginApi, cloudAvailable]
  )
  const observation = useMemo(() => workspaceSource.observe(t), [workspaceSource, t])
  const {
    installedPlugins,
    marketplaceItems,
    publishedMarketplaceItems,
    isLoadingPlugins,
    selectedPluginId,
    pendingUninstall,
    uninstallingPluginIds,
    pluginOperationNotice,
    activeTab,
    updatingPluginId,
    currentDeviceId,
    checkingMarketplaces,
    gitMarketplaceVersions,
  } = useSyncExternalStore(
    observation.subscribe,
    workspaceSource.getSnapshot,
    workspaceSource.getSnapshot
  )
  const {
    setSelectedPluginId,
    setPendingUninstall,
    setPluginOperationNotice,
    setActiveTab,
    toggleInstalledPlugin,
    togglePluginComponent,
    requestUninstallPlugin,
    confirmUninstallPlugin,
    copyMarketplacePlugin,
    updatePublishedPlugin,
    checkGitMarketplace,
    reconcileGitMarketplaceSources,
    removeConfiguredMarketplaceFromInventory,
    refresh,
  } = workspaceSource
  const [pendingUpdate, setPendingUpdate] = useState<{
    id: string | number
    name: string
    releaseId: number
    version: string
  } | null>(null)
  const tabs = [
    {
      id: 'codex',
      label: t('workbench.plugins_wework_surface', 'Codex 插件'),
      testId: 'plugin-management-surface-wework',
    },
    {
      id: 'core-dsh',
      label: t('workbench.plugins_core_dsh_surface', 'Wework 插件'),
      testId: 'plugin-management-surface-core-dsh',
    },
    {
      id: 'marketplaces',
      label: t('workbench.plugins_marketplace_sources'),
      testId: 'plugin-management-surface-marketplaces',
    },
  ] satisfies { id: PluginManagementTab; label: string; testId: string }[]

  const marketplaceById = useMemo(
    () => new Map(marketplaceItems.map(item => [String(item.id), item])),
    [marketplaceItems]
  )
  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => String(plugin.id) === String(selectedPluginId)) ?? null),
    [installedPlugins, selectedPluginId]
  )

  const createdPluginSlug = (plugin: InstalledPluginItem) =>
    plugin.raw.spec.source.pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  const findOwnedMarketplacePlugin = (plugin: InstalledPluginItem) => {
    const associated = findMarketplaceItemForInstalled(plugin, marketplaceItems)
    if (associated?.accessRole) return associated.accessRole === 'owner' ? associated : undefined
    if (
      isWegentManagedStorePlugin(plugin.raw) ||
      linkedCloudPluginId(plugin.raw) !== null ||
      plugin.raw.spec.pluginId != null
    )
      return undefined
    const slug = createdPluginSlug(plugin)
    return marketplaceItems.find(item => item.accessRole === 'owner' && item.name === slug)
  }

  const openInstalledPluginDetail = (plugin: InstalledPluginItem) => {
    const marketplaceItem =
      (typeof plugin.raw.spec.pluginId === 'number'
        ? marketplaceById.get(String(plugin.raw.spec.pluginId))
        : undefined) ?? findMarketplaceItemForInstalled(plugin, marketplaceItems)
    if (marketplaceItem && !marketplaceItemOwnsLocalCreatedPackage(marketplaceItem)) {
      navigateTo(
        buildPluginDetailRoute({
          pluginName: marketplaceItem.name || plugin.raw.spec.source.pluginKey,
          marketplaceName:
            marketplaceItemMarketplaceId(marketplaceItem) ||
            installedPluginMarketplaceId(plugin.raw) ||
            INTERNAL_DEVICE_MARKETPLACE_ID,
        })
      )
      return
    }
    const packableCreated =
      findPackableCreatedPlugin(installedPlugins, [
        plugin.raw.spec.source.pluginKey,
        createdPluginSlug(plugin),
        plugin.name,
      ]) ?? (isPackableCreatedPlugin(plugin) ? plugin : null)
    if (packableCreated?.origin === 'created') {
      setSelectedPluginId(packableCreated.id)
      return
    }
    if (marketplaceItem || isCloudManagedInstalledPlugin(plugin.raw)) {
      navigateTo(
        buildPluginDetailRoute({
          pluginName: marketplaceItem?.name || plugin.raw.spec.source.pluginKey,
          marketplaceName:
            (marketplaceItem && marketplaceItemMarketplaceId(marketplaceItem)) ||
            installedPluginMarketplaceId(plugin.raw) ||
            INTERNAL_DEVICE_MARKETPLACE_ID,
        })
      )
      return
    }
    setSelectedPluginId(plugin.id)
  }

  const openOwnerPublicationDetail = (plugin: InstalledPluginItem) => {
    const owned = findOwnedMarketplacePlugin(plugin)
    const target =
      findPackableCreatedPlugin(installedPlugins, [
        plugin.raw.spec.source.pluginKey,
        createdPluginSlug(plugin),
        plugin.name,
        owned?.name,
        owned?.displayName,
      ]) ?? (isPackableCreatedPlugin(plugin) ? plugin : null)
    const pluginName = target ? createdPluginSlug(target) : owned?.name
    if (!pluginName || (owned && owned.visibility !== 'personal')) {
      setPluginOperationNotice({
        id: `publish-missing-${plugin.id}`,
        kind: 'error',
        message: t(
          'workbench.plugins_publish_source_missing',
          '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
        ),
      })
      return
    }
    navigateTo(
      buildPluginDetailRoute({
        pluginName,
        marketplaceName: WEWORK_PERSONAL_MARKETPLACE_ID,
      })
    )
  }

  const pluginOperationNoticeOverlay = pluginOperationNotice ? (
    <PluginOperationNotice
      notice={pluginOperationNotice}
      onDismiss={() => setPluginOperationNotice(null)}
    />
  ) : null

  if (selectedPlugin) {
    const isUninstalling = uninstallingPluginIds.has(selectedPlugin.id)
    const ownedMarketplace = findOwnedMarketplacePlugin(selectedPlugin)
    const associatedListing =
      ownedMarketplace ?? findMarketplaceItemForInstalled(selectedPlugin, marketplaceItems) ?? null
    const packableCreated =
      associatedListing && !marketplaceItemOwnsLocalCreatedPackage(associatedListing)
        ? null
        : (findPackableCreatedPlugin(installedPlugins, [
            selectedPlugin.raw.spec.source.pluginKey,
            createdPluginSlug(selectedPlugin),
            selectedPlugin.name,
            ownedMarketplace?.name,
            ownedMarketplace?.displayName,
          ]) ?? (isPackableCreatedPlugin(selectedPlugin) ? selectedPlugin : null))
    const ownerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing: associatedListing,
    })
    const continueEditingKey = resolveContinueEditingPluginKey({
      packableCreated,
      currentPlugin: selectedPlugin,
      ownedListingName: ownedMarketplace?.name,
      listing: associatedListing,
    })
    const submissionStatus =
      typeof selectedPlugin.raw.spec.sourcePayload?.submissionStatus === 'string'
        ? (selectedPlugin.raw.spec.sourcePayload.submissionStatus as
            | 'uploading'
            | 'scanning'
            | 'pending'
            | 'approved'
            | 'rejected'
            | 'cancelled')
        : null
    const submissionReviewNote =
      typeof selectedPlugin.raw.spec.sourcePayload?.submissionReviewNote === 'string'
        ? selectedPlugin.raw.spec.sourcePayload.submissionReviewNote
        : null
    const openOwnerShare = () => openOwnerPublicationDetail(selectedPlugin)
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          backLabel={t('workbench.plugins_back_to_management', '返回管理插件')}
          usableOnThisDevice={pluginDetailReadyToTry(selectedPlugin, ownedMarketplace)}
          primaryActionLabel={
            isUninstalling
              ? t('workbench.plugins_uninstalling', '正在卸载')
              : t('workbench.plugins_try_now', '立即试用')
          }
          primaryActionDisabled={isUninstalling}
          showUninstall={!isUninstalling}
          accessRole={associatedListing?.accessRole}
          pluginVisibility={associatedListing?.visibility ?? null}
          shareRecipient={associatedListing?.accessRole === 'recipient'}
          shareGrantUserCount={ownedMarketplace?.grantUserCount ?? 0}
          shareGrantNamespaceCount={ownedMarketplace?.grantNamespaceCount ?? 0}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={ownerActions.canManageAccess ? openOwnerShare : undefined}
          submissionStatus={submissionStatus}
          submissionReviewNote={submissionReviewNote}
          onBack={() => setSelectedPluginId(null)}
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          onToggle={() => tryPluginInChat(selectedPlugin.raw)}
          onComponentToggle={(componentKey, enabled) =>
            togglePluginComponent(selectedPlugin.id, componentKey, enabled)
          }
          onUninstall={() => requestUninstallPlugin(selectedPlugin.id, selectedPlugin.name)}
        />
        {pluginOperationNoticeOverlay}
        {pendingUninstall && (
          <UninstallPluginDialog
            pluginName={pendingUninstall.name}
            scope={pendingUninstall.scope}
            onCancel={() => setPendingUninstall(null)}
            onConfirm={confirmUninstallPlugin}
          />
        )}
      </>
    )
  }

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background text-text-primary">
      <DesktopTopBar
        testId="plugin-management-topbar"
        className={[
          'sticky top-0 z-30 shrink-0 border-b border-border/75 bg-background/95 backdrop-blur-xl',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
        ].join(' ')}
        left={
          <>
            {topBarLeftActions}
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="plugin-management-back-button"
              className="plugin-route-back-button"
              onClick={() => navigateTo('/plugins')}
            >
              ‹ {t('workbench.plugins_back_to_marketplace', '返回插件市场')}
            </ControlButton>
          </>
        }
      />

      <div
        data-testid="plugin-management-page-content"
        className={[
          'mx-auto flex w-full max-w-[1060px] flex-col px-5 pb-[68px] md:px-[26px]',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          'pt-[27px]',
        ].join(' ')}
      >
        <header className="mb-5">
          <div>
            <h1 className="heading-base tracking-tight text-text-primary">
              {t('workbench.plugins_manage_plugins', '管理插件')}
            </h1>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t('workbench.plugins_manage_plugins_description', '管理已安装插件。')}
            </p>
          </div>
        </header>
        {showCoreDshTab ? (
          <TabsRoot
            value={activeTab}
            activation="automatic"
            loop
            onValueChange={next => {
              if (next) setActiveTab(next)
            }}
            render={<div className="contents" />}
          >
            <TabsList
              className="mb-5 flex min-h-11 items-end gap-6 border-b border-border md:min-h-0"
              aria-label={t('workbench.plugins_management_tabs_label', '插件类型')}
              data-testid="plugin-management-surface-tabs"
            >
              {tabs.map(tab => (
                <TabsTab
                  key={tab.id}
                  value={tab.id}
                  type="button"
                  id={`plugin-management-${tab.id}-tab`}
                  aria-controls={`plugin-management-${tab.id}-panel`}
                  data-testid={tab.testId}
                  className={[
                    'relative flex h-11 items-center px-0.5 text-sm font-medium transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:h-8',
                    activeTab === tab.id
                      ? 'text-text-primary'
                      : 'text-text-muted hover:text-text-secondary',
                  ].join(' ')}
                >
                  {tab.label}
                  {activeTab === tab.id && (
                    <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
                  )}
                </TabsTab>
              ))}
            </TabsList>
          </TabsRoot>
        ) : null}
        {showCoreDshTab && activeTab === 'core-dsh' ? (
          <div
            id="plugin-management-core-dsh-panel"
            role="tabpanel"
            aria-labelledby="plugin-management-core-dsh-tab"
            data-testid="plugin-management-core-dsh-panel"
          >
            <CoreDshPluginManagementSection onCreatePlugin={onCreateWeworkPlugin} />
          </div>
        ) : null}
        {showCoreDshTab && activeTab === 'marketplaces' && (
          <PluginMarketplaceManagement
            api={localPluginApi}
            checkingMarketplaces={checkingMarketplaces}
            onCheck={checkGitMarketplace}
            onSourcesLoaded={reconcileGitMarketplaceSources}
            onRemoved={removeConfiguredMarketplaceFromInventory}
            onReconcile={() => void refresh()}
          />
        )}
        {!showCoreDshTab || activeTab === 'codex' ? (
          <div
            id={showCoreDshTab ? 'plugin-management-codex-panel' : undefined}
            role={showCoreDshTab ? 'tabpanel' : undefined}
            aria-labelledby={showCoreDshTab ? 'plugin-management-codex-tab' : undefined}
            data-testid="plugin-management-codex-panel"
          >
            {isLoadingPlugins ? (
              <div className="py-10 text-sm text-text-secondary">
                {t('workbench.plugins_loading_plugins', '正在加载插件')}
              </div>
            ) : installedPlugins.length > 0 ? (
              <div
                data-testid="plugin-management-installed-list"
                className="rounded-[12px] border border-border/30 bg-background"
              >
                {installedPlugins.map(plugin => {
                  const marketplaceItem = plugin.raw.spec.pluginId
                    ? marketplaceById.get(String(plugin.raw.spec.pluginId))
                    : undefined
                  const listing =
                    marketplaceItem ?? findMarketplaceItemForInstalled(plugin, marketplaceItems)
                  const update = resolvePublishedPluginUpdate(
                    plugin,
                    findMarketplaceItemForInstalled(plugin, publishedMarketplaceItems)
                  )
                  const versionHint = findGitMarketplaceVersionHint(
                    plugin.raw,
                    gitMarketplaceVersions
                  )
                  const ownedMarketplace = findOwnedMarketplacePlugin(plugin)
                  const packableCreated =
                    listing && !marketplaceItemOwnsLocalCreatedPackage(listing)
                      ? null
                      : (findPackableCreatedPlugin(installedPlugins, [
                          plugin.raw.spec.source.pluginKey,
                          createdPluginSlug(plugin),
                          plugin.name,
                          ownedMarketplace?.name,
                          ownedMarketplace?.displayName,
                        ]) ?? (isPackableCreatedPlugin(plugin) ? plugin : null))
                  const ownerActions = resolvePluginOwnerActions({
                    isLocalCreated: Boolean(packableCreated),
                    ownedListing: ownedMarketplace ?? listing,
                  })
                  return (
                    <div
                      key={plugin.id}
                      className="border-b border-border/25 last:border-b-0 first:[&_.plugin-management-row]:rounded-t-[12px] last:[&_.plugin-management-row]:rounded-b-[12px]"
                    >
                      <InstalledPluginRow
                        plugin={plugin}
                        marketplaceItem={marketplaceItem}
                        availableUpdate={update ?? versionHint ?? undefined}
                        updating={updatingPluginId === plugin.id}
                        updateDisabled={updatingPluginId !== null || !currentDeviceId}
                        onUpdate={
                          update
                            ? () =>
                                setPendingUpdate({
                                  id: plugin.id,
                                  name: plugin.name,
                                  releaseId: update.releaseId,
                                  version: update.version,
                                })
                            : undefined
                        }
                        onOpen={() => openInstalledPluginDetail(plugin)}
                        onTry={() => tryPluginInChat(plugin.raw)}
                        onPublish={
                          ownerActions.showShareAction
                            ? () => openOwnerPublicationDetail(plugin)
                            : undefined
                        }
                        publishLabel={t('workbench.plugins_publish_to_marketplace', '发布')}
                        onShare={
                          ownerActions.canManageAccess
                            ? () => openOwnerPublicationDetail(plugin)
                            : undefined
                        }
                        shareLabel={t('workbench.plugins_manage_access', '管理权限')}
                        onCopy={
                          marketplaceItem?.accessRole === 'recipient' && marketplaceItem.allowCopy
                            ? () => void copyMarketplacePlugin(marketplaceItem)
                            : undefined
                        }
                        onToggle={() => toggleInstalledPlugin(plugin.id)}
                        onUninstall={() => requestUninstallPlugin(plugin.id, plugin.name)}
                        isUninstalling={uninstallingPluginIds.has(plugin.id)}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div
                data-testid="plugin-management-empty-state"
                className="rounded-[14px] border border-dashed border-border/35 bg-background px-[42px] py-[42px] text-center text-text-muted"
              >
                <strong className="mb-1.5 block font-medium text-text-primary">
                  {t('workbench.plugins_no_installed_plugins', '还没有安装插件')}
                </strong>
                <p className="mb-3.5 text-sm leading-5">
                  {t(
                    'workbench.plugins_no_installed_plugins_hint',
                    '安装后的插件会集中显示在这里。'
                  )}
                </p>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="plugin-management-browse-marketplace-button"
                  className="inline-flex h-[31px] items-center rounded-lg bg-surface px-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/20"
                  onClick={() => navigateTo('/plugins')}
                >
                  {t('workbench.plugins_browse_marketplace', '浏览插件市场')}
                </ControlButton>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {pluginOperationNoticeOverlay}
      {pendingUpdate && (
        <ConfirmDialog
          open
          title={t('workbench.plugins_update_title_named', { name: pendingUpdate.name })}
          description={t('workbench.plugins_update_confirm')}
          cancelLabel={t('common.cancel', '取消')}
          confirmLabel={t('workbench.plugins_update_target_version', {
            version: pendingUpdate.version.replace(/^v/i, ''),
          })}
          confirmTestId="plugin-management-update-confirm"
          dialogTestId="plugin-management-update-dialog"
          onClose={() => setPendingUpdate(null)}
          onConfirm={() => {
            setPendingUpdate(null)
            void updatePublishedPlugin(pendingUpdate.id, pendingUpdate.releaseId)
          }}
        />
      )}
      {pendingUninstall && (
        <UninstallPluginDialog
          pluginName={pendingUninstall.name}
          scope={pendingUninstall.scope}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={confirmUninstallPlugin}
        />
      )}
    </main>
  )
}
