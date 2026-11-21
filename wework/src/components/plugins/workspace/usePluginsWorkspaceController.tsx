import { useDialogRequests } from '@/components/common/useDialogRequests'
import { createPluginDetailNavigation } from './pluginWorkspaceNavigation'
import { useInstalledPluginDetail } from '../hooks/useInstalledPluginDetail'
import { useMarketplacePluginDetail } from '../hooks/useMarketplacePluginDetail'
import { useOpenAiPluginCatalog } from '@/features/plugins/useOpenAiPluginCatalog'
import type { FormEvent } from 'react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import type { PluginsWorkspaceProps } from './pluginWorkspaceTypes'
import { createPluginMarketplaceRowLabels } from './pluginMarketplaceLabels'
import { useTranslation } from '@/hooks/useTranslation'
import { createPluginWorkspaceOperations } from '../workspace/pluginWorkspaceOperations'
import { createPluginMarketplaceViewport } from '../workspace/pluginMarketplaceViewport'
import {
  usePluginConnectorHealth,
  pluginConnectorActionError,
} from '../workspace/pluginConnectorHealthState'
import { usePluginWorkspacePublishing } from '../workspace/usePluginWorkspacePublishing'
import { usePluginWorkspaceConnectors } from '../workspace/usePluginWorkspaceConnectors'
import { usePluginWorkspaceInstallation } from '../workspace/usePluginWorkspaceInstallation'
import { usePluginWorkspaceDeletion } from '../workspace/usePluginWorkspaceDeletion'
import { usePluginInstalledOperations } from './usePluginInstalledOperations'
import { usePluginWorkspaceCatalog } from './usePluginWorkspaceCatalog'
import {
  matchingPublicationRequests,
  selectPrimaryPublication,
} from '../workspace/pluginPublicationState'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import { useLocalExecutorCloudConnectionStatus } from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import { personalPluginInstallSource } from './personalPluginInstallSource'
import {
  getPluginInventoryMutationVersion,
  pluginMarketplaceCacheKey,
} from '@/features/plugins/pluginMarketplaceCache'
import { usePluginWorkspaceFilters } from './usePluginWorkspaceFilters'
import { createPluginMarketplaceRowAction } from './pluginMarketplaceRowActions'
import {
  findMarketplaceItemForPluginReference,
  openMarketplacePluginDetailSelection,
  usePluginDetailSelection,
} from '../hooks/usePluginDetailSelection'
import { usePluginInstallActions } from '../hooks/usePluginInstallActions'
import type { PluginMarketplaceItem, PluginPublicationRequestItem } from '@/types/api'
import { type InstalledPluginItem } from '../PluginManagementRows'
import { useOptionalAppearance } from '@/features/appearance'
import { linkedCloudInstalledPluginId } from '../installedPluginMerge'
import { findMarketplaceItemForInstalled } from '../findMarketplaceItemForInstalled'
import { type MarketplaceSearchInputHandle } from '../MarketplaceSearchInput'
import { type MarketplaceCategorySection } from '../marketplaceCategorySections'
import { pluginUninstallScope, type PluginUninstallScope } from '../pluginUninstall'
import { findPackableCreatedPlugin } from '../pluginOwnerLocalPackage'
import {
  MARKETPLACE_SEARCH_RESULT_BATCH_SIZE,
  cloudMarketplaceKey,
  currentDeviceInstallation,
  findInstalledPluginForMarketplaceItem,
  isCodexCatalogItem,
  isMarketplaceSourceValid,
  localMarketplaceIdFromItem,
  localMarketplaceKey,
  marketplacePluginDetailSelectionKey,
  marketplacePluginDetailSource,
  rememberMarketplaceKey,
  resolveMarketplaceUninstallId,
  isMarketplaceUninstallPending,
  toMarketplaceInstalledPluginItem,
  withMarketplaceDetailComponents,
  withMarketplaceListingInterface,
  type AddMarketFormData,
  type MarketplaceOption,
} from '../workspace/marketplaceWorkspaceHelpers'

export function usePluginsWorkspaceController({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudMarketplaceAvailable = true,
  cloudApiBaseUrl,
  cloudToken,
  cloudUserId,
  pluginReference = null,
}: PluginsWorkspaceProps) {
  const { t } = useTranslation('common')
  const { confirm: requestConfirmation, dialogs: requestDialogs } = useDialogRequests(
    (key, fallback) => t(key, fallback)
  )
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const localExecutorCloudConnection = useLocalExecutorCloudConnectionStatus()
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const operationScope = pluginMarketplaceCacheKey(cloudApiBaseUrl, cloudToken)
  const operations = useMemo(
    () => createPluginWorkspaceOperations(operationScope),
    [operationScope]
  )
  const {
    installingMarketplacePluginIds,
    uninstallingPluginIds,
    updatingPluginPolicyIds,
    pendingLocalConnectorAuth,
    connectorActionSlug,
    connectorAuthRevision,
  } = useSyncExternalStore(operations.subscribe, operations.getSnapshot, operations.getSnapshot)
  const [pendingPluginUninstall, setPendingPluginUninstall] = useState<{
    id: string | number
    name: string
    scope: PluginUninstallScope
  } | null>(null)
  const [localPluginDetailActionError, setPluginDetailActionError] = useState<{
    pluginId: string | number
    message: string
    source?: 'detail-read' | 'auth-health'
  } | null>(null)
  const [marketplaceDetailRevision, setMarketplaceDetailRevision] = useState(0)

  const [showAddMarketDialog, setShowAddMarketDialog] = useState(false)
  const [showPluginImportDialog, setShowPluginImportDialog] = useState(false)
  const [addMarketForm, setAddMarketForm] = useState<AddMarketFormData>({
    source: '',
    gitRef: '',
    subPath: '',
  })
  const [isAddingMarket, setIsAddingMarket] = useState(false)
  const {
    pluginApi,
    accountPluginApi,
    canInstallForAccount,
    localSyncResource,
    localSyncAvailable,
    deviceCloudConnected,
    localPluginApi,
    marketplaceCacheKeyValue,
    knownExecutorDeviceId,
    catalog,
    reconciliationRevision,
    reconciliation,
    installedPlugins,
    pluginMarketplaceState,
    marketplaces,
    selectedMarketplaceKey,
    currentDeviceId,
    isMarketplaceRefreshing,
    marketplaceLoadingMessage,
    deviceAutoSyncSettled,
    pluginOperationNotice,
    localInventoryReady,
  } = usePluginWorkspaceCatalog({
    cloudApiBaseUrl,
    cloudToken,
    cloudMarketplaceAvailable,
    t,
    localExecutorCloudConnection,
    installingMarketplacePluginIds,
    uninstallingPluginIds,
    updatingPluginPolicyIds,
    pendingLocalConnectorAuth,
    onReconciliationComplete: () => setBrowsingCategoryKey(null),
  })
  const marketplaceSearchInputRef = useRef<MarketplaceSearchInputHandle>(null)
  const marketplaceViewport = useMemo(() => createPluginMarketplaceViewport(), [])
  const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
    string | number | null
  >(
    () =>
      findMarketplaceItemForPluginReference(
        catalog.getSnapshot().pluginMarketplaceState.items,
        pluginReference
      )?.id ?? null
  )
  const openPluginCreator = useCallback(() => {
    setIsCreateMenuOpen(false)
    navigateTo('/plugins/create')
  }, [])

  const selectedMarketplace = useMemo(
    () =>
      marketplaces.find(marketplace => marketplace.key === selectedMarketplaceKey) ??
      marketplaces[0] ??
      null,
    [marketplaces, selectedMarketplaceKey]
  )
  const hasMarketplace = selectedMarketplace !== null

  const filters = usePluginWorkspaceFilters({
    items: pluginMarketplaceState.items,
    installedPlugins,
    marketplaces,
    hasMarketplace,
    t,
  })
  const {
    query,
    setQuery,
    setSearchResultWindow,
    selectedDistributionTab,
    marketplaceDistributionFilter,
    marketplaceSourceFilterKey,
    setMarketplaceSourceFilterKey,
    setBrowsingCategoryKey,
    marketplaceDistributionLabels,
    localMarketplaceTabs,
    normalizedQuery,
    visibleSearchResultLimit,
    visibleMarketplaceItems,
    marketplaceCategorySections,
    browsingCategorySection,
    installedStripPlugins,
    hiddenInstalledPlugins,
    showInstalledStrip,
    selectDistributionTab,
    selectLocalMarketplaceTab,
    clearMarketplaceFilters,
  } = filters
  const openAiCatalog = useOpenAiPluginCatalog({
    cacheKey: marketplaceCacheKeyValue,
    accountScope: JSON.stringify([cloudApiBaseUrl ?? '', cloudUserId ?? null]),
    deviceId: knownExecutorDeviceId,
    enabled: selectedDistributionTab === 'official' && !marketplaceSourceFilterKey,
    restoreForAll: selectedDistributionTab === 'all' && !marketplaceSourceFilterKey,
    readCatalog: localPluginApi.readRemoteCatalog,
  })
  const isOpenAiOfficialViewLoading =
    selectedDistributionTab === 'official' &&
    !marketplaceSourceFilterKey &&
    !normalizedQuery &&
    visibleMarketplaceItems.length === 0 &&
    openAiCatalog.loading
  const isMarketplaceSearchUpdating = Boolean(normalizedQuery) && isMarketplaceRefreshing

  const marketplaceRowLabels = useMemo(() => createPluginMarketplaceRowLabels(t), [t])

  const {
    selectedPlugin: selectedPluginSummary,
    selectedMarketplacePlugin,
    dismissPluginReferenceDetail,
  } = usePluginDetailSelection({
    scopeKey: JSON.stringify([marketplaceCacheKeyValue, currentDeviceId]),
    pluginReference,
    pluginMarketplaceState,
    installedPlugins,
    selectedPluginId,
    selectedMarketplacePluginId,
    setSelectedPluginId,
    setSelectedMarketplacePluginId,
  })

  const {
    isUploadingPlugin,
    pluginShareState,
    setPluginShareState,
    pluginShareSaving,
    pluginShareError,
    pluginSharePreparing,
    pluginPublishTarget,
    setPluginPublishTarget,
    pluginPublishAccess,
    setPluginPublishAccess,
    pluginPublishPreparing,
    publications,
    publicationRequests,
    publicationProgress,
    publicationProgressLoading,
    withdrawingPublicationId,
    openPublicationProgress,
    withdrawPublication,
    pluginPublishError,
    setPluginPublishError,
    pluginPublishShareRecovery,
    setPluginPublishShareRecovery,
    createdPluginSlug,
    findOwnedMarketplacePlugin,
    openPublishCreatedPlugin,
    openPackablePublish,
    publishCreatedPlugin,
    openPluginShare,
    openCreatedPluginAccess,
    recoverPublishToShare,
    savePluginShare,
    versionSubmission,
    personalInstallation,
    copyMarketplacePlugin,
    searchPluginShareUsers,
    searchPluginShareGroups,
  } = usePluginWorkspacePublishing({
    catalog,
    setSelectedMarketplacePluginId,
    setSelectedPluginId,
    pluginApi,
    accountPluginApi,
    accountIdentity: { apiBaseUrl: cloudApiBaseUrl, userId: cloudUserId },
    canInstallForAccount,
    personalDetailSourceKey:
      (selectedPluginSummary
        ? personalPluginInstallSource([selectedPluginSummary])
        : selectedMarketplacePlugin &&
          personalPluginInstallSource(installedPlugins, selectedMarketplacePlugin)
      )?.key ?? null,
    localPluginApi,
    t,
    installedPlugins,
    pluginMarketplaceState,
    marketplaceCacheKeyValue,
  })
  const isReconcilingPlugins = reconciliation.active
  // Complete current-account inventory remains usable while native cleanup is reconciled.
  const reconciliationBlocksActions =
    isReconcilingPlugins && !reconciliation.waitingOnNative && !localInventoryReady
  const isOfficialCatalogView =
    selectedDistributionTab === 'official' && !marketplaceSourceFilterKey
  const isCatalogRefreshBusy = isOfficialCatalogView
    ? openAiCatalog.loading
    : pluginMarketplaceState.isLoading || isMarketplaceRefreshing || isReconcilingPlugins

  const refreshMarketplace = () => {
    if (isOfficialCatalogView) {
      if (!openAiCatalog.loading) openAiCatalog.refresh()
      return
    }
    if (isReconcilingPlugins) return
    setBrowsingCategoryKey(null)
    catalog.refresh(true)
    personalInstallation.refreshAccountCatalog()
  }

  const refreshLocalMarketplace = (options?: { reloadCatalog: boolean }) => {
    setBrowsingCategoryKey(null)
    catalog.refresh(false, options?.reloadCatalog === true)
  }

  const addMarketplace = (event: FormEvent) => {
    event.preventDefault()
    const isCurrent = catalog.captureScope()
    const source = addMarketForm.source.trim()
    if (!isMarketplaceSourceValid(source)) return

    setIsAddingMarket(true)

    // Build the full path from the supported marketplace source formats.
    let fullPath = source
    if (/^[\w-]+\/[\w-]+$/.test(source)) {
      fullPath = `https://github.com/${source}.git`
    }

    if (addMarketForm.gitRef.trim()) {
      fullPath = `${fullPath}#${addMarketForm.gitRef.trim()}`
    }
    if (addMarketForm.subPath.trim()) {
      fullPath = `${fullPath}:${addMarketForm.subPath.trim()}`
    }

    localPluginApi
      .upsertMarketplace({
        path: fullPath,
      })
      .then(state => {
        if (!isCurrent()) return
        catalog.acceptLocalMarketplaces(state)
        if (state.selectedMarketplaceId) {
          const selectedKey = localMarketplaceKey(state.selectedMarketplaceId)
          rememberMarketplaceKey(selectedKey)
          catalog.selectMarketplace(selectedKey)
          setMarketplaceSourceFilterKey(selectedKey)
        }
        setAddMarketForm({ source: '', gitRef: '', subPath: '' })
        setShowAddMarketDialog(false)
        refreshMarketplace()
      })
      .catch((error: Error) => {
        catalog.reportError(error.message)
      })
      .finally(() => {
        setIsAddingMarket(false)
      })
  }

  const isMarketplacePluginLocallyUninstalling = useCallback(
    (item: PluginMarketplaceItem) =>
      isMarketplaceUninstallPending(item, installedPlugins, uninstallingPluginIds),
    [installedPlugins, uninstallingPluginIds]
  )

  const isMarketplacePluginUninstalling = useCallback(
    (item: PluginMarketplaceItem) => {
      const latest =
        catalog
          .getSnapshot()
          .pluginMarketplaceState.items.find(
            candidate => String(candidate.id) === String(item.id)
          ) ?? item
      return (
        latest.currentDeviceInstallation?.state === 'uninstalling' ||
        isMarketplaceUninstallPending(
          latest,
          catalog.getSnapshot().installedPlugins,
          operations.getSnapshot().uninstallingPluginIds
        )
      )
    },
    [catalog, operations]
  )

  const isInstalledPluginUninstalling = useCallback(
    (plugin: InstalledPluginItem) => {
      const latest =
        catalog
          .getSnapshot()
          .installedPlugins.find(candidate => String(candidate.id) === String(plugin.id)) ?? plugin
      if (operations.getSnapshot().uninstallingPluginIds.has(String(latest.id))) return true
      if (
        currentDeviceInstallation(latest.raw, catalog.getSnapshot().currentDeviceId)?.state ===
        'uninstalling'
      )
        return true
      if (pluginUninstallScope(latest.raw) === 'published-source') return false
      const listing = findMarketplaceItemForInstalled(
        latest,
        catalog.getSnapshot().pluginMarketplaceState.items
      )
      return listing ? isMarketplacePluginUninstalling(listing) : false
    },
    [isMarketplacePluginUninstalling, catalog, operations]
  )

  const { beginMarketplacePluginTrial, tryMarketplacePluginInChat } = usePluginInstallActions({
    installedPlugins,
    localPluginApi,
    isUninstalling: isMarketplacePluginUninstalling,
    t,
    reportCatalogError: catalog.reportError,
  })

  const requestUninstallPlugin = (id: string | number, name: string) => {
    const plugin = installedPlugins.find(
      item =>
        String(item.id) === String(id) ||
        String(linkedCloudInstalledPluginId(item.raw)) === String(id)
    )
    const catalogItem =
      catalog
        .getSnapshot()
        .pluginMarketplaceState.items.find(item => String(item.installedPluginId) === String(id)) ??
      catalog
        .getSnapshot()
        .pluginMarketplaceState.items.find(item => String(item.id) === String(id))
    setPendingPluginUninstall({
      id,
      name,
      scope: plugin
        ? pluginUninstallScope(plugin.raw)
        : catalogItem && isCodexCatalogItem(catalogItem)
          ? 'local'
          : 'account',
    })
  }

  const marketplaceUninstallId = (item: PluginMarketplaceItem) =>
    resolveMarketplaceUninstallId(item, installedPlugins)
  const confirmUninstallPlugin = () => {
    if (!pendingPluginUninstall) return
    const { id, name } = pendingPluginUninstall
    setPendingPluginUninstall(null)
    uninstallInstalledPlugin(id, name)
  }

  const {
    pendingPersonalPluginDelete,
    setPendingPersonalPluginDelete,
    isDeletingPersonalPlugin,
    requestDeletePersonalPlugin,
    confirmDeletePersonalPlugin,
  } = usePluginWorkspaceDeletion({
    publicationRequests,
    pluginApi,
    accountPluginApi: canInstallForAccount ? accountPluginApi : null,
    catalog,
    t,
    publications,
    localPluginApi,
    marketplaceCacheKeyValue,
    setSelectedPluginId,
    setSelectedMarketplacePluginId,
    refreshLocalMarketplace: options => refreshLocalMarketplace(options),
  })
  const selectedMarketplaceDetailKey = selectedMarketplacePlugin
    ? JSON.stringify([
        marketplaceCacheKeyValue,
        currentDeviceId,
        getPluginInventoryMutationVersion(),
        marketplacePluginDetailSelectionKey(selectedMarketplacePlugin),
        marketplaces.find(
          entry => entry.id === localMarketplaceIdFromItem(selectedMarketplacePlugin)
        )?.path,
      ])
    : ''
  const marketplaceInstalledDetail = selectedMarketplacePlugin
    ? findInstalledPluginForMarketplaceItem(selectedMarketplacePlugin, installedPlugins)
    : null
  const marketplaceBaseDetail = useMemo(
    () =>
      selectedMarketplacePlugin
        ? marketplaceInstalledDetail
          ? withMarketplaceListingInterface(marketplaceInstalledDetail, selectedMarketplacePlugin)
          : toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)
        : null,
    [selectedMarketplacePlugin, marketplaceInstalledDetail]
  )
  const {
    detail: selectedMarketplacePluginDetail,
    loading: marketplaceDetailLoading,
    error: marketplaceDetailLoadError,
  } = useMarketplacePluginDetail({
    selectionKey: selectedMarketplaceDetailKey,
    revision: marketplaceDetailRevision,
    base: marketplaceBaseDetail,
    errorMessage: t('workbench.plugins_detail_load_failed', '插件详情加载失败，请重试。'),
    read:
      selectedMarketplacePlugin && localMarketplaceIdFromItem(selectedMarketplacePlugin)
        ? () =>
            marketplaceInstalledDetail
              ? localPluginApi.readInstalledPluginDetail(marketplaceInstalledDetail.raw)
              : localPluginApi.readMarketplacePluginDetail(
                  marketplacePluginDetailSource(
                    selectedMarketplacePlugin,
                    catalog.getSnapshot().marketplaces
                  ),
                  selectedMarketplacePlugin.name,
                  {
                    version: JSON.stringify([
                      selectedMarketplacePlugin.version,
                      selectedMarketplacePlugin.latestReleaseId,
                    ]),
                  }
                )
        : undefined,
  })

  const selectedPlugin = useInstalledPluginDetail(
    selectedPluginSummary,
    localPluginApi.readInstalledPluginDetail,
    (pluginId, error) =>
      setPluginDetailActionError({
        pluginId,
        message: getErrorMessage(error, 'Unable to load plugin details'),
        source: 'detail-read',
      }),
    reconciliationRevision,
    pluginId =>
      setPluginDetailActionError(current =>
        current?.source === 'detail-read' && String(current.pluginId) === String(pluginId)
          ? null
          : current
      )
  )

  const closePluginDetail = createPluginDetailNavigation(
    pluginReference,
    dismissPluginReferenceDetail
  )
  const detailPlugin = useMemo(
    () =>
      selectedPlugin
        ? selectedPlugin
        : selectedMarketplacePlugin
          ? (selectedMarketplacePluginDetail ??
            findInstalledPluginForMarketplaceItem(selectedMarketplacePlugin, installedPlugins) ??
            toMarketplaceInstalledPluginItem(selectedMarketplacePlugin))
          : null,
    [selectedPlugin, selectedMarketplacePlugin, selectedMarketplacePluginDetail, installedPlugins]
  )
  const healthDetailId = selectedMarketplacePluginId ?? selectedPluginId
  const { source: connectorHealth, snapshot: connectorHealthSnapshot } = usePluginConnectorHealth({
    scope: [
      marketplaceCacheKeyValue,
      currentDeviceId,
      healthDetailId,
      detailPlugin?.raw.spec.source.marketplace,
      detailPlugin?.raw.spec.source.pluginKey,
    ],
    detail: detailPlugin,
    t,
    revision: connectorAuthRevision,
    busy: connectorActionSlug !== null,
    actionError: localPluginDetailActionError,
    setActionError: setPluginDetailActionError,
    captureScope: catalog.captureScope,
  })
  const { states: localConnectorAuthBySlug, error: connectorHealthError } = connectorHealthSnapshot
  const { togglePluginComponent, changePluginAutoUpdatePolicy, uninstallInstalledPlugin } =
    usePluginInstalledOperations({
      installedPlugins,
      catalog,
      marketplaceCacheKeyValue,
      knownExecutorDeviceId,
      localPluginApi,
      pluginApi,
      currentDeviceId,
      operations,
      t,
      reconciliationBlocksActions,
      setSelectedPluginId,
      connectorHealth,
    })
  const {
    pendingCodexAuthorization,
    setPendingCodexAuthorization,
    checkingCodexAuthorization,
    ensureMarketplaceConnectors,
    rollbackInstalledPluginAfterAuthFailure,
    ensureLocalConnectorsAfterInstall,
    managePluginConnector,
    verifyCodexAuthorization,
  } = usePluginWorkspaceConnectors({
    requestConfirmation,
    operations,
    cloudApiBaseUrl,
    cloudToken,
    t,
    catalog,
    pluginApi,
    currentDeviceId,
    localPluginApi,
    connectorHealth,
    selectedMarketplacePluginId,
    selectedPluginId,
    setPluginDetailActionError,
    localConnectorAuthBySlug,
  })

  const {
    pendingInstall,
    setPendingInstall,
    pendingPluginUpdate,
    setPendingPluginUpdate,
    connectionNamesRequiredForInstall,
    installMarketplacePlugin,
    executeMarketplaceInstall,
  } = usePluginWorkspaceInstallation({
    requestConfirmation,
    selectedMarketplacePlugin,
    selectedMarketplacePluginDetail,
    localPluginApi,
    catalog,
    cloudApiBaseUrl,
    cloudToken,
    t,
    pluginApi,
    localSyncResource,
    isMarketplacePluginUninstalling,
    reconciliationBlocksActions,
    operations,
    marketplaceCacheKeyValue,
    installedPlugins,
    beginMarketplacePluginTrial,
    ensureMarketplaceConnectors,
    rollbackInstalledPluginAfterAuthFailure,
    ensureLocalConnectorsAfterInstall,
    personalInstallation,
  })
  const requiredConnections = useMemo(
    () =>
      selectedMarketplacePlugin
        ? createAsyncResource(selectedMarketplaceDetailKey, () =>
            connectionNamesRequiredForInstall(
              withMarketplaceDetailComponents(
                selectedMarketplacePlugin,
                selectedMarketplacePluginDetail
              )
            )
          )
        : null,
    [
      connectionNamesRequiredForInstall,
      selectedMarketplacePlugin,
      selectedMarketplacePluginDetail,
      selectedMarketplaceDetailKey,
    ]
  )
  const subscribeRequired = useCallback(
    (listener: () => void) =>
      requiredConnections ? requiredConnections.subscribe(listener) : () => {},
    [requiredConnections]
  )
  const requiredSnapshot = useSyncExternalStore(
    subscribeRequired,
    requiredConnections?.getSnapshot ?? getIdleResourceSnapshot,
    requiredConnections?.getSnapshot ?? getIdleResourceSnapshot
  )
  const selectedRequiredConnectionNames = requiredSnapshot.data ?? null
  const pluginDetailActionError = pluginConnectorActionError(
    localPluginDetailActionError,
    healthDetailId,
    connectorHealthError
  )
  const marketplaceFilterKey = JSON.stringify([
    marketplaceDistributionFilter,
    marketplaceSourceFilterKey,
    normalizedQuery,
  ])
  const bindMarketplaceViewport = useCallback(
    (element: HTMLDivElement | null) =>
      element ? marketplaceViewport.attach(element, marketplaceFilterKey) : undefined,
    [marketplaceViewport, marketplaceFilterKey]
  )

  const pluginPublishOwnedListing = pluginPublishTarget
    ? findOwnedMarketplacePlugin(pluginPublishTarget)
    : null
  const pluginPublishPublication = pluginPublishTarget
    ? selectPrimaryPublication(
        matchingPublicationRequests(
          publicationRequests,
          pluginPublishOwnedListing?.visibility === 'personal'
            ? Number(pluginPublishOwnedListing.id)
            : null,
          createdPluginSlug(pluginPublishTarget)
        )
      )
    : null
  const openPublicationRevision = (publication: PluginPublicationRequestItem) => {
    const target = findPackableCreatedPlugin(installedPlugins, [
      publication.pluginSlug,
      publication.pluginName,
    ])
    if (!target) {
      catalog.reportError(
        t(
          'workbench.plugins_publish_source_missing',
          '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
        )
      )
      return
    }
    publications.closeProgress()
    openPublishCreatedPlugin(target)
  }
  const openPublishedEnterprisePlugin = async (publication: PluginPublicationRequestItem) => {
    if (!publication.enterprisePluginId) {
      await openPublicationProgress(publication.id)
      return
    }
    let enterpriseItem = catalog
      .getSnapshot()
      .pluginMarketplaceState.items.find(
        item => String(item.id) === String(publication.enterprisePluginId)
      )
    try {
      if (!enterpriseItem) {
        const response = await pluginApi.listMarketplacePlugins({
          q: publication.pluginSlug,
          deviceId: currentDeviceId || undefined,
        })
        enterpriseItem = response.items.find(
          item => String(item.id) === String(publication.enterprisePluginId)
        )
        if (enterpriseItem) {
          const nextEnterpriseItem = enterpriseItem
          catalog.includeMarketplaceItem(nextEnterpriseItem)
        }
      }
      if (!enterpriseItem) throw new Error('Enterprise plugin is not available in the catalog')
      publications.closeProgress()
      setSelectedPluginId(null)
      setSelectedMarketplacePluginId(enterpriseItem.id)
    } catch {
      catalog.showNotice({
        id: 'enterprise-plugin-unavailable-' + publication.id,
        kind: 'error',
        message: t(
          'workbench.plugins_publication_enterprise_unavailable',
          '企业版本已经发布，但市场目录尚未同步完成，请稍后刷新。'
        ),
      })
    }
  }
  const publicationProgressHistory = publicationProgress
    ? matchingPublicationRequests(
        publicationRequests,
        publicationProgress.pluginId,
        publicationProgress.pluginSlug
      )
    : []

  const openMarketplacePluginDetail = (item: PluginMarketplaceItem) => {
    marketplaceViewport.remember()
    openMarketplacePluginDetailSelection({
      item,
      installedPlugins,
      findPackableCreatedPlugin,
      setSelectedPluginId,
      setSelectedMarketplacePluginId,
    })
  }

  const openInstalledPluginDetail = (plugin: InstalledPluginItem) => {
    const marketplaceItem = findMarketplaceItemForInstalled(plugin, pluginMarketplaceState.items)
    if (marketplaceItem) {
      openMarketplacePluginDetail(marketplaceItem)
      return
    }
    setSelectedMarketplacePluginId(null)
    setSelectedPluginId(plugin.id)
  }

  const handleMarketplaceRowAction = createPluginMarketplaceRowAction({
    open: openMarketplacePluginDetail,
    install: item => {
      void installMarketplacePlugin(item)
    },
    try: tryMarketplacePluginInChat,
    copy: item => {
      void copyMarketplacePlugin(item)
    },
    uninstall: item =>
      requestUninstallPlugin(marketplaceUninstallId(item), item.displayName || item.name),
    clearBrowsing: () => setBrowsingCategoryKey(null),
  })
  const handleSelectDistributionTab = useCallback(
    (distribution: typeof selectedDistributionTab) => {
      rememberMarketplaceKey('')
      selectDistributionTab(distribution)
    },
    [selectDistributionTab]
  )
  const handleSelectLocalMarketplaceTab = useCallback(
    (marketplace: MarketplaceOption) => {
      rememberMarketplaceKey(marketplace.key)
      catalog.selectMarketplace(marketplace.key)
      selectLocalMarketplaceTab(marketplace.key)
    },
    [selectLocalMarketplaceTab, catalog]
  )
  const handleClearMarketplaceFilters = useCallback(() => {
    marketplaceSearchInputRef.current?.clear()
    rememberMarketplaceKey('')
    catalog.selectMarketplace(cloudMarketplaceKey())
    clearMarketplaceFilters()
  }, [clearMarketplaceFilters, catalog])
  const handleRevealMore = useCallback(
    (section: MarketplaceCategorySection) => {
      if (section.flat && normalizedQuery) {
        setSearchResultWindow(current => ({
          query: normalizedQuery,
          limit:
            (current.query === normalizedQuery
              ? current.limit
              : MARKETPLACE_SEARCH_RESULT_BATCH_SIZE) + MARKETPLACE_SEARCH_RESULT_BATCH_SIZE,
        }))
        return
      }
      setBrowsingCategoryKey(section.key)
    },
    [normalizedQuery, setBrowsingCategoryKey, setSearchResultWindow]
  )
  return {
    requestDialogs,
    selectedPlugin,
    findOwnedMarketplacePlugin,
    pluginMarketplaceState,
    publicationRequests,
    createdPluginSlug,
    installedPlugins,
    currentDeviceId,
    isInstalledPluginUninstalling,
    pluginPublishPreparing,
    isUploadingPlugin,
    openCreatedPluginAccess,
    openPackablePublish,
    t,
    pluginDetailActionError,
    withdrawingPublicationId,
    openPublishedEnterprisePlugin,
    openPublicationProgress,
    openPublicationRevision,
    versionSubmission,
    personalInstallation,
    closePluginDetail,
    setSelectedPluginId,
    requestDeletePersonalPlugin,
    setPluginDetailActionError,
    togglePluginComponent,
    updatingPluginPolicyIds,
    changePluginAutoUpdatePolicy,
    requestUninstallPlugin,
    managePluginConnector,
    localConnectorAuthBySlug,
    connectorActionSlug,
    selectedMarketplacePlugin,
    detailPlugin,
    selectedMarketplacePluginDetail,
    selectedRequiredConnectionNames,
    deviceAutoSyncSettled,
    installingMarketplacePluginIds,
    isMarketplacePluginUninstalling,
    reconciliationBlocksActions,
    openPluginShare,
    marketplaceDetailLoading,
    pluginSharePreparing,
    marketplaceDetailLoadError,
    setMarketplaceDetailRevision,
    copyMarketplacePlugin,
    setSelectedMarketplacePluginId,
    installMarketplacePlugin,
    beginMarketplacePluginTrial,
    marketplaceUninstallId,
    sidebarCollapsed,
    topBarLeftActions,
    isReconcilingPlugins,
    localSyncAvailable,
    isMarketplaceRefreshing,
    openAiCatalog,
    isOfficialCatalogView,
    reconciliationRevision,
    isCatalogRefreshBusy,
    refreshMarketplace,
    isCreateMenuOpen,
    setIsCreateMenuOpen,
    openPluginCreator,
    setShowPluginImportDialog,
    setShowAddMarketDialog,
    reconciliation,
    hasMarketplace,
    marketplaces,
    selectedMarketplaceKey,
    selectedDistributionTab,
    marketplaceSourceFilterKey,
    marketplaceDistributionLabels,
    localMarketplaceTabs,
    query,
    marketplaceSearchInputRef,
    bindMarketplaceViewport,
    showInstalledStrip,
    installedStripPlugins,
    hiddenInstalledPlugins,
    openInstalledPluginDetail,
    marketplaceLoadingMessage,
    isMarketplaceSearchUpdating,
    isOpenAiOfficialViewLoading,
    normalizedQuery,
    visibleMarketplaceItems,
    marketplaceCategorySections,
    visibleSearchResultLimit,
    cloudToken,
    isMarketplacePluginLocallyUninstalling,
    deviceCloudConnected,
    localInventoryReady,
    marketplaceRowLabels,
    handleSelectDistributionTab,
    handleSelectLocalMarketplaceTab,
    setQuery,
    handleClearMarketplaceFilters,
    handleRevealMore,
    handleMarketplaceRowAction,
    browsingCategorySection,
    setBrowsingCategoryKey,
    showAddMarketDialog,
    isAddingMarket,
    addMarketForm,
    setAddMarketForm,
    addMarketplace,
    pluginShareState,
    pluginShareSaving,
    pluginShareError,
    setPluginShareState,
    savePluginShare,
    searchPluginShareUsers,
    searchPluginShareGroups,
    pluginPublishTarget,
    pluginPublishError,
    pluginPublishAccess,
    pluginPublishPublication,
    setPluginPublishTarget,
    setPluginPublishAccess,
    pluginPublishShareRecovery,
    recoverPublishToShare,
    setPluginPublishError,
    setPluginPublishShareRecovery,
    publishCreatedPlugin,
    publicationProgress,
    publicationProgressHistory,
    publicationProgressLoading,
    publications,
    withdrawPublication,
    pluginOperationNotice,
    catalog,
    pendingInstall,
    appearanceMode,
    pendingPluginUpdate,
    setPendingPluginUpdate,
    setPendingInstall,
    executeMarketplaceInstall,
    pendingPluginUninstall,
    setPendingPluginUninstall,
    confirmUninstallPlugin,
    pendingPersonalPluginDelete,
    isDeletingPersonalPlugin,
    setPendingPersonalPluginDelete,
    confirmDeletePersonalPlugin,
    pendingLocalConnectorAuth,
    operations,
    pendingCodexAuthorization,
    checkingCodexAuthorization,
    setPendingCodexAuthorization,
    verifyCodexAuthorization,
    showPluginImportDialog,
    pluginApi,
    localPluginApi,
    setMarketplaceSourceFilterKey,
    refreshLocalMarketplace,
  }
}
export type PluginsWorkspaceController = ReturnType<typeof usePluginsWorkspaceController>
