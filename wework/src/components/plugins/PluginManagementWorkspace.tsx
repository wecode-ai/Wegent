import { createPluginManagementSource, type PluginManagementTab } from './pluginManagementSource'

import type { KeyboardEvent, ReactNode } from 'react'
import { useMemo, useSyncExternalStore } from 'react'
import { getToken } from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import {
  createLocalDevicePluginApi,
  resolveLocalPluginDeviceRouteId,
} from '@/features/plugins/pluginDeviceApi'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'

import { queuePluginTrial } from '@/features/plugins/pluginTrial'

import { pluginMarketplaceCacheKey } from '@/features/plugins/pluginMarketplaceCache'
import { useTranslation } from '@/hooks/useTranslation'

import { navigateTo } from '@/lib/navigation'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { INTERNAL_DEVICE_MARKETPLACE_ID } from '@/features/plugins/marketplaceIdentity'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import type { InstalledPlugin } from '@/types/api'
import { InstalledPluginRow, type InstalledPluginItem } from './PluginManagementRows'
import {
  isCloudManagedInstalledPlugin,
  isWegentManagedStorePlugin,
  linkedCloudPluginId,
} from './installedPluginMerge'

import { PluginDetailView } from './PluginDetailView'
import { PluginOperationNotice } from './PluginOperationNotice'
import { resolvePluginOwnerActions } from './pluginOwnerActions'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from './pluginOwnerLocalPackage'
import { UninstallPluginDialog } from './plugin-dialogs/UninstallPluginDialog'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from './pluginDistribution'
import { findMarketplaceItemForInstalled } from './findMarketplaceItemForInstalled'
import { pluginDetailReadyToTry } from './pluginDetailReadyToTry'
import { getRuntimeConfig } from '@/config/runtime'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { CoreDshPluginManagementSection } from './CoreDshPluginManagementSection'

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

  const showCoreDshTab = isElectronRuntime()
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const profile = {
      apiBaseUrl: resolvedCloudApiBaseUrl,
      token: cloudToken === undefined ? getToken() : cloudToken,
    }
    return createLocalDevicePluginApi(
      createPluginApi(
        createHttpClient({
          baseUrl: profile.apiBaseUrl,
          getToken: () => profile.token,
          ...(cloudToken === undefined ? {} : { redirectOnUnauthorized: false }),
        }),
        resolvedCloudApiBaseUrl
      ),
      deviceId => resolveLocalPluginDeviceRouteId(deviceId, profile)
    )
  }, [cloudToken, resolvedCloudApiBaseUrl])

  const workspaceSource = useMemo(
    () =>
      createPluginManagementSource({
        cacheKey: marketplaceCacheKeyValue,
        knownDeviceId,
        localPluginApi,
        cloudPluginApi,
      }),
    [marketplaceCacheKeyValue, knownDeviceId, localPluginApi, cloudPluginApi]
  )
  const observation = useMemo(() => workspaceSource.observe(t), [workspaceSource, t])
  const {
    installedPlugins,
    marketplaceItems,
    isLoadingPlugins,
    selectedPluginId,
    pendingUninstall,
    uninstallingPluginIds,
    pluginOperationNotice,
    activeTab,
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
  } = workspaceSource
  const selectTab = (tab: PluginManagementTab) => {
    setActiveTab(tab)
    document.getElementById(`plugin-management-${tab}-tab`)?.focus()
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: PluginManagementTab) => {
    if (!showCoreDshTab) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    selectTab(tab === 'codex' ? 'core-dsh' : 'codex')
  }

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
            <button
              type="button"
              data-testid="plugin-management-back-button"
              className="plugin-route-back-button"
              onClick={() => navigateTo('/plugins')}
            >
              ‹ {t('workbench.plugins_back_to_marketplace', '返回插件市场')}
            </button>
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
          <div
            className="mb-5 flex min-h-11 items-end gap-6 border-b border-border md:min-h-0"
            role="tablist"
            aria-label={t('workbench.plugins_management_tabs_label', '插件类型')}
            data-testid="plugin-management-surface-tabs"
          >
            <button
              type="button"
              id="plugin-management-codex-tab"
              role="tab"
              aria-selected={activeTab === 'codex'}
              aria-controls="plugin-management-codex-panel"
              tabIndex={activeTab === 'codex' ? 0 : -1}
              data-testid="plugin-management-surface-wework"
              onClick={() => setActiveTab('codex')}
              onKeyDown={event => handleTabKeyDown(event, 'codex')}
              className={[
                'relative flex h-11 items-center px-0.5 text-sm font-medium transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:h-8',
                activeTab === 'codex'
                  ? 'text-text-primary'
                  : 'text-text-muted hover:text-text-secondary',
              ].join(' ')}
            >
              {t('workbench.plugins_wework_surface', 'Codex 插件')}
              {activeTab === 'codex' ? (
                <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
              ) : null}
            </button>
            <button
              type="button"
              id="plugin-management-core-dsh-tab"
              role="tab"
              aria-selected={activeTab === 'core-dsh'}
              aria-controls="plugin-management-core-dsh-panel"
              tabIndex={activeTab === 'core-dsh' ? 0 : -1}
              data-testid="plugin-management-surface-core-dsh"
              onClick={() => setActiveTab('core-dsh')}
              onKeyDown={event => handleTabKeyDown(event, 'core-dsh')}
              className={[
                'relative flex h-11 items-center px-0.5 text-sm font-medium transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:h-8',
                activeTab === 'core-dsh'
                  ? 'text-text-primary'
                  : 'text-text-muted hover:text-text-secondary',
              ].join(' ')}
            >
              {t('workbench.plugins_core_dsh_surface', 'Wework 插件')}
              {activeTab === 'core-dsh' ? (
                <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
              ) : null}
            </button>
          </div>
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
                <button
                  type="button"
                  data-testid="plugin-management-browse-marketplace-button"
                  className="inline-flex h-[31px] items-center rounded-lg bg-surface px-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/20"
                  onClick={() => navigateTo('/plugins')}
                >
                  {t('workbench.plugins_browse_marketplace', '浏览插件市场')}
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {pluginOperationNoticeOverlay}
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
