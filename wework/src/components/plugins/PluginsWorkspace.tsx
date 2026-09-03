import { RefreshCw, Settings2 } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { ApiError } from '@/api/http'
import {
  createLocalCodexPluginApi,
  listPersonalMarketplacePluginsFromDisk,
  peekLocalCodexPluginsReadState,
} from '@/api/local/codexPlugins'
import { authorizeWegentConnector, listWegentConnectorApps } from '@/api/cloud/connectorApps'
import { track } from '@/telemetry/client'
import {
  isLocalBrowserConnector,
  isLocalConnector,
  localConnectorAuthHealth,
  localConnectorAuthLogout,
  localQrManageActionFromHealth,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import { openCloudAuthorizationWindow } from '@/lib/cloud-authorization-window'
import {
  refreshLocalExecutorCloudConnectionStatus,
  useLocalExecutorCloudConnectionStatus,
} from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import {
  notifyLocalPluginSkillsChanged,
  queuePluginPromptTrial,
} from '@/features/plugins/pluginTrial'
import { buildPluginDetailRoute, type PluginReference } from '@/features/plugins/pluginNavigation'
import {
  isPersonalMarketplaceId,
  WEWORK_PERSONAL_MARKETPLACE_ID,
} from '@/features/plugins/builtinPlugins'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import {
  LocalConnectorPluginSyncTimeoutError,
  waitForLocalConnectorAuthAvailability,
} from '@/features/plugins/waitForLocalConnectorAuthAvailability'
import {
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  sameInstalledPlugins,
  sameMarketplaceItems,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { useMarketplaceFilters } from './hooks/useMarketplaceFilters'
import { usePluginMarketplaceCatalog } from './hooks/usePluginMarketplaceCatalog'
import {
  findMarketplaceItemForPluginReference,
  openMarketplacePluginDetailSelection,
  usePluginDetailSelection,
} from './hooks/usePluginDetailSelection'
import { usePluginInstallActions } from './hooks/usePluginInstallActions'
import { InstalledPluginStrip } from './workspace/InstalledPluginStrip'
import { MarketplaceCatalogView } from './workspace/MarketplaceCatalogView'
import {
  beginPluginDeviceSync,
  collectPluginDeviceStatusReports,
  hasAttemptedPluginDeviceAutoSync,
  hasAttemptedPluginDeviceStatusReport,
  hasSettledPluginDeviceAutoSync,
  marketplaceItemNeedsDeviceSync,
  marketplaceItemOffersDeviceSyncRetry,
  marketplaceNeedsDeviceSync,
  markPluginDeviceAutoSyncAttempted,
  markPluginDeviceAutoSyncSettled,
  markPluginDeviceStatusReportAttempted,
  withAcknowledgedDeviceInstallations,
  withAcknowledgedMarketplaceDeviceState,
  withOptimisticDevicePending,
} from '@/features/plugins/pluginDeviceAutoSync'
import {
  marketplaceItemCanRetryPluginUpdate,
  marketplaceItemHasPausedPluginAutoUpdate,
  marketplaceItemNeedsPluginAutoUpdate,
  runPluginAutoUpdate,
} from '@/features/plugins/pluginAutoUpdate'
import { PLUGIN_AUTO_UPDATE_COMPLETED_EVENT } from '@/features/plugins/PluginAutoUpdateCoordinator'
import type {
  InstalledPlugin,
  PluginAccessResponse,
  PluginAccessUpdateRequest,
  PluginMarketplaceItem,
  PluginDeleteImpactResponse,
  PluginPublicationRequestItem,
  PluginSubmissionCompleteResponse,
} from '@/types/api'
import { connectorDisplayName } from './connectorDisplayName'
import { holdBackInFlightMarketplaceInstalls } from './holdBackInFlightMarketplaceInstalls'
import { retainMarketplaceInstalledState } from './retainMarketplaceInstallHints'
import { type InstalledPluginItem } from './PluginManagementRows'
import { PluginCreateMenu } from './PluginCreateMenu'
import { PluginImportDialog } from './PluginImportDialog'
import { PluginDetailView } from './PluginDetailView'
import { PluginOperationNotice, type PluginOperationNoticeState } from './PluginOperationNotice'
import { PluginPublishDialog, type PluginPublishRequest } from './PluginPublishDialog'
import { PluginPublicationProgressDrawer } from './PluginPublicationProgressDrawer'
import { PluginShareDialog } from './PluginShareDialog'
import { InstallPluginDialog } from './plugin-dialogs/InstallPluginDialog'
import { DeletePersonalPluginDialog } from './plugin-dialogs/DeletePersonalPluginDialog'
import { UninstallPluginDialog } from './plugin-dialogs/UninstallPluginDialog'
import { useOptionalAppearance } from '@/features/appearance'
import { resolvePluginLogo } from './plugin-assets'
import {
  isCloudManagedInstalledPlugin,
  linkedCloudPluginId,
  mergeInstalledPlugins,
  resolveProgressiveLocalInstalledRaw,
  storeDirMatchesPluginKey,
} from './installedPluginMerge'
import { findMarketplaceItemForInstalled } from './findMarketplaceItemForInstalled'
import {
  isLocalMarketplaceItem,
  mergeDiskPersonalIntoLocalRows,
  mergeMarketplaceCatalog,
} from './marketplaceCatalogMerge'
import {
  humanizeMarketplaceInstallError,
  humanizeMarketplaceUninstallError,
} from './marketplaceInstallError'
import { type MarketplaceSearchInputHandle } from './MarketplaceSearchInput'
import { marketplacePluginLockLabel, resolveMarketplacePluginLock } from './marketplacePluginLock'
import { type MarketplaceCategorySection } from './marketplaceCategorySections'
import { pluginUninstallWarningDetails, uninstallPluginIdentities } from './pluginUninstall'
import {
  canRecoverShareAfterVersionConflict,
  resolvePluginOwnerActions,
} from './pluginOwnerActions'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from './pluginOwnerLocalPackage'
import { withPublishedPluginCloudLink } from './publishedPluginIdentity'
import { marketplaceItemMarketplaceId, marketplacePluginDistribution } from './pluginDistribution'
import { pluginDetailReadyToTry } from './pluginDetailReadyToTry'

import {
  CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS,
  MARKETPLACE_SEARCH_RESULT_BATCH_SIZE,
  cloudMarketplaceKey,
  createDefaultPluginApi,
  currentDeviceInstallation,
  findInstalledPluginForMarketplaceItem,
  hasOpenAiOfficialCatalog,
  isCodexCatalogItem,
  isMarketplaceSourceValid,
  isUserAddedMarketplace,
  keepRicherMarketplacePluginDetail,
  localMarketplaceIdFromItem,
  localMarketplaceKey,
  marketplaceComponentCount,
  mergeWarmInstalledPlugins,
  mergeWarmMarketplaceItems,
  mergeWarmMarketplaceOptions,
  nonCodexCatalogItems,
  pluginDetailActionErrorMessage,
  pluginUsesWegentConnectorOAuth,
  preferNonEmptyCatalogRows,
  rememberMarketplaceKey,
  rememberedMarketplaceKey,
  requiredConnectionNames,
  toInstalledPluginItem,
  toMarketplaceInstalledPluginItem,
  toMarketplaceOptions,
  tryPluginInChat,
  withMarketplaceDetailComponents,
  withMarketplaceListingInterface,
  withMarketplacePluginDetail,
  type AddMarketFormData,
  type MarketplaceOption,
  type PluginMarketplaceState,
  type PluginShareState,
} from './workspace/marketplaceWorkspaceHelpers'
import { AddMarketDialog } from './workspace/AddMarketDialog'
import { CategoryBrowseDialog } from './workspace/CategoryBrowseDialog'
import {
  type PluginMarketplaceRowAction,
  type PluginMarketplaceRowLabels,
} from './workspace/PluginMarketplaceRow'

interface PluginsWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  cloudMarketplaceAvailable?: boolean
  cloudApiBaseUrl?: string
  cloudToken?: string | null
  pluginReference?: PluginReference | null
}

interface PendingMarketplaceInstall {
  item: PluginMarketplaceItem
  requiredConnectionNames: string[]
  promptAfterInstall?: string
}

const DEVICE_STATUS_REPORT_MAX_RETRIES = 3
const DEVICE_STATUS_REPORT_RETRY_BASE_MS = 1000
const TERMINAL_PUBLICATION_STATUSES = new Set(['published', 'withdrawn', 'closed'])

function comparePublicationRequests(
  left: PluginPublicationRequestItem,
  right: PluginPublicationRequestItem
): number {
  const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  return updatedDifference !== 0 ? updatedDifference : right.id - left.id
}

function mergePublicationRequests(
  current: PluginPublicationRequestItem[],
  incoming: PluginPublicationRequestItem[]
): PluginPublicationRequestItem[] {
  const byId = new Map(current.map(publication => [publication.id, publication]))
  for (const publication of incoming) byId.set(publication.id, publication)
  return [...byId.values()].sort(comparePublicationRequests)
}

function matchingPublicationRequests(
  publications: PluginPublicationRequestItem[],
  sourcePluginId: number | null,
  pluginSlug: string
): PluginPublicationRequestItem[] {
  const normalizedSlug = pluginSlug.trim().toLowerCase()
  return publications
    .filter(publication => {
      if (sourcePluginId !== null && publication.pluginId === sourcePluginId) return true
      return publication.pluginSlug.trim().toLowerCase() === normalizedSlug
    })
    .sort(comparePublicationRequests)
}

function selectPrimaryPublication(
  publications: PluginPublicationRequestItem[]
): PluginPublicationRequestItem | null {
  return (
    publications.find(publication => !TERMINAL_PUBLICATION_STATUSES.has(publication.status)) ??
    publications.find(publication => publication.status === 'published') ??
    publications[0] ??
    null
  )
}

export function PluginsWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudMarketplaceAvailable = true,
  cloudApiBaseUrl,
  cloudToken,
  pluginReference = null,
}: PluginsWorkspaceProps) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const localExecutorCloudConnection = useLocalExecutorCloudConnectionStatus()
  const deviceCloudConnected =
    localExecutorCloudConnection.apiBaseUrl === (cloudApiBaseUrl || '') &&
    localExecutorCloudConnection.connected
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const [installingMarketplacePluginIds, setInstallingMarketplacePluginIds] = useState<
    Set<string | number>
  >(() => new Set())
  const installingMarketplacePluginIdsRef = useRef(installingMarketplacePluginIds)
  installingMarketplacePluginIdsRef.current = installingMarketplacePluginIds
  const [uninstallingPluginIds, setUninstallingPluginIds] = useState<Set<string | number>>(
    () => new Set()
  )
  const [updatingPluginPolicyIds, setUpdatingPluginPolicyIds] = useState<Set<string | number>>(
    () => new Set()
  )
  const [pluginOperationNotice, setPluginOperationNotice] =
    useState<PluginOperationNoticeState | null>(null)
  const [pendingInstall, setPendingInstall] = useState<PendingMarketplaceInstall | null>(null)
  const [pendingPluginUninstall, setPendingPluginUninstall] = useState<{
    id: string | number
    name: string
  } | null>(null)
  const [pendingPersonalPluginDelete, setPendingPersonalPluginDelete] = useState<{
    pluginName: string
    displayName: string
    marketplacePath: string | null
    installedId: string | number | null
    cloudPluginId: string | number | null
    deleteLocalSource: boolean
    impact: PluginDeleteImpactResponse | null
    publication: PluginPublicationRequestItem | null
  } | null>(null)
  const [isDeletingPersonalPlugin, setIsDeletingPersonalPlugin] = useState(false)
  const [pendingLocalConnectorAuth, setPendingLocalConnectorAuth] = useState<{
    target: LocalConnectorAuthTarget
    title: string
    resolve: () => void
    reject: (error: Error) => void
  } | null>(null)
  const pendingLocalConnectorAuthRef = useRef(pendingLocalConnectorAuth)
  pendingLocalConnectorAuthRef.current = pendingLocalConnectorAuth
  const [localConnectorAuthBySlug, setLocalConnectorAuthBySlug] = useState<
    Record<string, 'connected' | 'disconnected'>
  >({})
  const [pluginDetailActionError, setPluginDetailActionError] = useState<{
    pluginId: string | number
    message: string
  } | null>(null)
  const [selectedRequiredConnectionNames, setSelectedRequiredConnectionNames] = useState<
    string[] | null
  >(null)
  const [isUploadingPlugin, setIsUploadingPlugin] = useState(false)
  const [marketplaceLoadingMessage, setMarketplaceLoadingMessage] = useState('')
  const [marketplaceRefreshTick, setMarketplaceRefreshTick] = useState(0)

  useEffect(() => {
    const refreshAfterAutoUpdate = () => setMarketplaceRefreshTick(previous => previous + 1)
    window.addEventListener(PLUGIN_AUTO_UPDATE_COMPLETED_EVENT, refreshAfterAutoUpdate)
    return () =>
      window.removeEventListener(PLUGIN_AUTO_UPDATE_COMPLETED_EVENT, refreshAfterAutoUpdate)
  }, [])

  const [showAddMarketDialog, setShowAddMarketDialog] = useState(false)
  const [showPluginImportDialog, setShowPluginImportDialog] = useState(false)
  const [addMarketForm, setAddMarketForm] = useState<AddMarketFormData>({
    source: '',
    gitRef: '',
    subPath: '',
  })
  const [isAddingMarket, setIsAddingMarket] = useState(false)
  const pluginApi = useMemo(
    () => createDefaultPluginApi(cloudApiBaseUrl, cloudToken),
    [cloudApiBaseUrl, cloudToken]
  )
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const marketplaceCacheKeyValue = useMemo(
    () => pluginMarketplaceCacheKey(cloudApiBaseUrl, cloudToken),
    [cloudApiBaseUrl, cloudToken]
  )
  const initialMarketplaceCache = getPluginMarketplaceCache(marketplaceCacheKeyValue)
  // The account-scoped cloud cache and the local Codex cache cover different
  // catalogs. Always read both so a cloud-only snapshot cannot hide OpenAI/local
  // rows until the slow plugin/list request finishes.
  const initialDurablePeek = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
  const initialInstalledPlugins = mergeWarmInstalledPlugins(
    initialMarketplaceCache,
    initialDurablePeek
  )
  const initialMarketplaceItems = mergeWarmMarketplaceItems(
    initialMarketplaceCache,
    initialDurablePeek
  )
  const initialMarketplaceItemsWithInstalls = mergeMarketplaceCatalog(
    initialMarketplaceItems.filter(item => !isCodexCatalogItem(item)),
    initialMarketplaceItems.filter(isCodexCatalogItem),
    initialInstalledPlugins.map(plugin => plugin.raw)
  )
  const initialMarketplaceLoadKeyRef = useRef<string | null>(null)
  const marketplaceSearchInputRef = useRef<MarketplaceSearchInputHandle>(null)
  const marketplaceScrollRegionRef = useRef<HTMLDivElement>(null)
  const marketplaceReturnScrollTopRef = useRef<number | null>(null)
  const preparingInstallPluginIdsRef = useRef(new Set<string | number>())
  const autoUpdateAttemptKeysRef = useRef(new Set<string>())
  const deviceStatusReportFailureCountsRef = useRef(new Map<string, number>())
  const deviceStatusReportRetryTimerRef = useRef<number | null>(null)
  // Durable peek / warm cache already paints the catalog — do not start in a
  // "refreshing" skeleton state just because Codex plugin/list will revalidate.
  const [isMarketplaceRefreshing, setIsMarketplaceRefreshing] = useState(false)
  const [isOpenAiOfficialCatalogLoading, setIsOpenAiOfficialCatalogLoading] = useState(
    () => !hasOpenAiOfficialCatalog(initialMarketplaceItems)
  )
  const [marketplaces, setMarketplaces] = useState<MarketplaceOption[]>(() => {
    return mergeWarmMarketplaceOptions(
      initialMarketplaceCache,
      initialDurablePeek,
      cloudMarketplaceAvailable,
      'Wework 云端市场'
    )
  })
  const [selectedMarketplaceKey, setSelectedMarketplaceKey] = useState(
    () => initialMarketplaceCache?.selectedMarketplaceKey || rememberedMarketplaceKey()
  )
  // Always open the marketplace on the "全部" distribution tab; do not restore a
  // previously selected local marketplace filter when navigating back from another route.
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>(() => {
    return initialInstalledPlugins
  })
  const [currentDeviceId, setCurrentDeviceId] = useState(
    () => initialMarketplaceCache?.deviceId || initialDurablePeek?.deviceId || ''
  )
  const [pluginShareState, setPluginShareState] = useState<PluginShareState | null>(null)
  const [pluginShareSaving, setPluginShareSaving] = useState(false)
  const [pluginShareError, setPluginShareError] = useState<string | null>(null)
  const [pluginSharePreparing, setPluginSharePreparing] = useState(false)
  const [pluginPublishTarget, setPluginPublishTarget] = useState<InstalledPluginItem | null>(null)
  const [pluginPublishAccess, setPluginPublishAccess] = useState<PluginAccessResponse | null>(null)
  const [pluginPublishPreparing, setPluginPublishPreparing] = useState(false)
  const [publicationRequests, setPublicationRequests] = useState<PluginPublicationRequestItem[]>([])
  const [publicationProgress, setPublicationProgress] =
    useState<PluginPublicationRequestItem | null>(null)
  const [publicationProgressLoading, setPublicationProgressLoading] = useState(false)
  const [withdrawingPublicationId, setWithdrawingPublicationId] = useState<number | null>(null)
  const [pluginPublishError, setPluginPublishError] = useState<string | null>(null)
  const [pluginPublishShareRecovery, setPluginPublishShareRecovery] = useState(false)
  const refreshPublicationRequests = useCallback(
    async (sourcePluginId?: number): Promise<PluginPublicationRequestItem[]> => {
      const pageSize = 100
      const first = await pluginApi.listPublicationRequests({
        sourcePluginId,
        page: 1,
        limit: pageSize,
      })
      const pageCount = Math.max(1, Math.ceil(first.total / pageSize))
      const remainingPages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, index) =>
          pluginApi.listPublicationRequests({
            sourcePluginId,
            page: index + 2,
            limit: pageSize,
          })
        )
      )
      const summaries = [first, ...remainingPages].flatMap(response => response.items)
      const details = await Promise.all(
        summaries.map(summary => pluginApi.getPublicationRequest(summary.id))
      )
      setPublicationRequests(previous => mergePublicationRequests(previous, details))
      return details.sort(comparePublicationRequests)
    },
    [pluginApi]
  )
  const [pluginMarketplaceState, setPluginMarketplaceState] = useState<PluginMarketplaceState>(
    () => {
      return {
        items: initialMarketplaceItemsWithInstalls,
        isLoading: initialMarketplaceItemsWithInstalls.length === 0,
        error: null,
      }
    }
  )
  const pluginReferenceRef = useRef(pluginReference)
  pluginReferenceRef.current = pluginReference
  const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
    string | number | null
  >(
    () =>
      findMarketplaceItemForPluginReference(initialMarketplaceItemsWithInstalls, pluginReference)
        ?.id ?? null
  )
  const [deviceAutoSyncSettled, setDeviceAutoSyncSettled] = useState(() =>
    hasSettledPluginDeviceAutoSync(currentDeviceId)
  )
  const [localInstalledStateReadyKey, setLocalInstalledStateReadyKey] = useState<string | null>(
    null
  )
  const [personalDiskSettledKey, setPersonalDiskSettledKey] = useState<string | null>(null)
  const localInventoryReady = localInstalledStateReadyKey === marketplaceCacheKeyValue
  const marketplaceStateCacheKeyRef = useRef(marketplaceCacheKeyValue)
  const installedPluginsRef = useRef(installedPlugins)
  installedPluginsRef.current = installedPlugins
  const marketplacesRef = useRef(marketplaces)
  marketplacesRef.current = marketplaces
  const pluginMarketplaceStateRef = useRef(pluginMarketplaceState)
  pluginMarketplaceStateRef.current = pluginMarketplaceState
  const selectedMarketplaceKeyRef = useRef(selectedMarketplaceKey)
  selectedMarketplaceKeyRef.current = selectedMarketplaceKey
  const currentDeviceIdRef = useRef(currentDeviceId)
  currentDeviceIdRef.current = currentDeviceId
  const deferredCodexCatalogRequestRef = useRef('')
  const reconcileGithubCatalogRef = useRef(false)
  const skipGithubCatalogReconcileRef = useRef(false)
  useEffect(() => {
    setDeviceAutoSyncSettled(hasSettledPluginDeviceAutoSync(currentDeviceId))
  }, [currentDeviceId])
  // Account/session identity is encoded in the cache key. Cloud installs come from that
  // account cache, while a matching device-local snapshot remains authoritative for
  // packages already materialized on this device.
  useEffect(() => {
    const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
    const durablePeek = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
    const nextInstalled = mergeWarmInstalledPlugins(cached, durablePeek)
    const warmItems = mergeWarmMarketplaceItems(cached, durablePeek)
    const items = mergeMarketplaceCatalog(
      warmItems.filter(item => !isCodexCatalogItem(item)),
      warmItems.filter(isCodexCatalogItem),
      nextInstalled.map(plugin => plugin.raw)
    )
    const nextMarketplaces = mergeWarmMarketplaceOptions(
      cached,
      durablePeek,
      cloudMarketplaceAvailable,
      t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
    )
    const nextMarketplaceState: PluginMarketplaceState = {
      items,
      isLoading: items.length === 0,
      error: null,
    }
    // Effects for the new account run in the same commit. Publish the rebuilt
    // refs before marking them as owned by the new cache key so no async catalog
    // merge can retain state from the previous account.
    installedPluginsRef.current = nextInstalled
    pluginMarketplaceStateRef.current = nextMarketplaceState
    marketplaceStateCacheKeyRef.current = marketplaceCacheKeyValue
    setMarketplaces(nextMarketplaces)
    setSelectedMarketplaceKey(cached?.selectedMarketplaceKey || rememberedMarketplaceKey())
    setInstalledPlugins(nextInstalled)
    // Peek / deviceId alone must not green-light auto-sync. Live plugin/installed
    // plus the cloud marketplace+installed responses set this later.
    setLocalInstalledStateReadyKey(null)
    setPersonalDiskSettledKey(null)
    deferredCodexCatalogRequestRef.current = ''
    reconcileGithubCatalogRef.current = false
    setCurrentDeviceId(cached?.deviceId || durablePeek?.deviceId || '')
    setIsMarketplaceRefreshing(false)
    setIsOpenAiOfficialCatalogLoading(!hasOpenAiOfficialCatalog(items))
    setPluginMarketplaceState(nextMarketplaceState)
    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(
      findMarketplaceItemForPluginReference(items, pluginReferenceRef.current)?.id ?? null
    )
    setPluginDetailActionError(null)
    setPluginShareState(null)
    setPluginPublishTarget(null)
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    initialMarketplaceLoadKeyRef.current = null
  }, [cloudMarketplaceAvailable, marketplaceCacheKeyValue, t])
  const lastMarketplaceRefreshTickRef = useRef(0)

  useEffect(
    () => () => {
      if (deviceStatusReportRetryTimerRef.current !== null) {
        window.clearTimeout(deviceStatusReportRetryTimerRef.current)
      }
    },
    []
  )
  usePluginMarketplaceCatalog({
    installedPlugins,
    setPluginMarketplaceState,
  })
  const openPluginCreator = useCallback(() => {
    setIsCreateMenuOpen(false)
    navigateTo('/plugins/create')
  }, [])
  const [selectedMarketplacePluginDetail, setSelectedMarketplacePluginDetail] =
    useState<InstalledPluginItem | null>(null)

  const selectedMarketplace = useMemo(
    () =>
      marketplaces.find(marketplace => marketplace.key === selectedMarketplaceKey) ??
      marketplaces[0] ??
      null,
    [marketplaces, selectedMarketplaceKey]
  )
  const hasMarketplace = selectedMarketplace !== null

  const filters = useMarketplaceFilters({
    items: pluginMarketplaceState.items,
    installedPlugins,
    marketplaces,
    isOpenAiOfficialCatalogLoading,
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
    isOpenAiOfficialViewLoading,
    browsingCategorySection,
    installedStripPlugins,
    hiddenInstalledPlugins,
    showInstalledStrip,
    selectDistributionTab,
    selectLocalMarketplaceTab,
    clearMarketplaceFilters,
  } = filters
  const isMarketplaceSearchUpdating = Boolean(normalizedQuery) && isMarketplaceRefreshing

  const marketplaceRowLabels = useMemo<PluginMarketplaceRowLabels>(
    () => ({
      install: t('workbench.plugins_install', '安装'),
      installing: t('workbench.plugins_installing', '正在安装'),
      uninstalling: t('workbench.plugins_uninstalling', '正在卸载'),
      retry: t('workbench.plugins_retry_install', '重试安装'),
      syncing: t('workbench.plugins_syncing_installation', '同步中...'),
      try: t('workbench.plugins_try_now', '立即对话'),
      manage: t('workbench.plugins_manage', '管理'),
      uninstall: t('workbench.plugins_uninstall', '卸载'),
      copy: t('workbench.plugins_copy_to_personal', '复制到我的插件'),
    }),
    [t]
  )

  const applyLocalMarketplaceState = useCallback(
    (state: Awaited<ReturnType<typeof localPluginApi.readState>>) => {
      const options = toMarketplaceOptions(
        state.marketplaces,
        cloudMarketplaceAvailable,
        t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
      )
      setMarketplaces(options)
      setMarketplaceSourceFilterKey(current =>
        current &&
        options.some(
          marketplace => marketplace.key === current && isUserAddedMarketplace(marketplace)
        )
          ? current
          : ''
      )
      setSelectedMarketplaceKey(current => {
        // 优先选择云端市场作为默认选项
        if (cloudMarketplaceAvailable && !current) {
          return cloudMarketplaceKey()
        }
        // 如果用户已经手动选择了某个市场，保持该选择
        if (current && options.some(marketplace => marketplace.key === current)) {
          return current
        }
        // 如果之前保存的市场仍然存在，使用它
        const selectedKey = state.selectedMarketplaceId
          ? localMarketplaceKey(state.selectedMarketplaceId)
          : ''
        if (selectedKey && options.some(marketplace => marketplace.key === selectedKey)) {
          return selectedKey
        }
        // 最后，如果云端市场可用，使用云端市场；否则使用第一个本地市场
        if (cloudMarketplaceAvailable) return cloudMarketplaceKey()
        return options[0]?.key || ''
      })
    },
    [cloudMarketplaceAvailable, localPluginApi, setMarketplaceSourceFilterKey, t]
  )

  const applyLiveCodexCatalog = useCallback(
    (localState: Awaited<ReturnType<typeof localPluginApi.readState>>) => {
      startTransition(() => {
        const previousItems = pluginMarketplaceStateRef.current.items
        const previousCloudItems = previousItems.filter(item => !isCodexCatalogItem(item))
        // An empty plugin/list (GitHub timeout) must not rebuild cloud rows that
        // still need wegent ZIP/install; that would drop pending and release the
        // shared Codex lock to a hung GitHub reconcile.
        if (
          localState.marketplaceItems.length === 0 &&
          previousCloudItems.some(marketplaceItemNeedsDeviceSync)
        ) {
          if (localState.deviceId) setCurrentDeviceId(localState.deviceId)
          setIsOpenAiOfficialCatalogLoading(false)
          setIsMarketplaceRefreshing(false)
          return
        }
        setCurrentDeviceId(localState.deviceId)
        applyLocalMarketplaceState(localState)
        const cloudInstalledRaw = installedPluginsRef.current
          .map(plugin => plugin.raw)
          .filter(plugin => typeof plugin.spec.pluginId === 'number')
        const nextInstalledRaw = mergeInstalledPlugins(
          cloudInstalledRaw,
          localState.installedPlugins,
          localState.deviceId || currentDeviceIdRef.current || ''
        ).map(toInstalledPluginItem)
        // Keep existing cloud rows (device pending/failed inclusive). Only refresh the
        // Codex/OpenAI slice from plugin/list so retain hints cannot invent
        // installedLocally=true on account installs that still need device sync.
        const previousById = new Map(
          pluginMarketplaceStateRef.current.items.map(item => [String(item.id), item] as const)
        )
        const localPluginKeys = new Set(
          localState.installedPlugins.flatMap(plugin => {
            const name = String(plugin.spec.source.pluginKey || plugin.metadata.name || '')
              .trim()
              .toLowerCase()
            const id = String(
              plugin.spec.source.catalogItemId ||
                (plugin.metadata.labels && typeof plugin.metadata.labels === 'object'
                  ? (plugin.metadata.labels as Record<string, unknown>).id
                  : '') ||
                ''
            )
              .trim()
              .toLowerCase()
            const keys = [name, id]
            const pluginId = plugin.spec.pluginId
            if (typeof pluginId === 'number') keys.push(String(pluginId))
            const prefix = /^(\d+)-/.exec(id)
            if (prefix) keys.push(prefix[1])
            return keys.filter(Boolean)
          })
        )
        const localStoreDirs = localState.installedPlugins.flatMap(plugin => {
          const id = String(
            plugin.spec.source.catalogItemId ||
              (plugin.metadata.labels && typeof plugin.metadata.labels === 'object'
                ? (plugin.metadata.labels as Record<string, unknown>).id
                : '') ||
              plugin.metadata.name ||
              ''
          )
          return id ? [id] : []
        })
        const nextItems = mergeMarketplaceCatalog(
          pluginMarketplaceStateRef.current.items.filter(item => !isCodexCatalogItem(item)),
          localState.marketplaceItems,
          localState.installedPlugins
        ).map(item => {
          const previous = previousById.get(String(item.id))
          const withDeviceState = previous?.currentDeviceInstallation
            ? {
                ...item,
                currentDeviceInstallation:
                  item.currentDeviceInstallation ?? previous.currentDeviceInstallation,
              }
            : item
          if (isCodexCatalogItem(withDeviceState)) return withDeviceState
          const catalogName = String(withDeviceState.name).trim().toLowerCase()
          const catalogId = String(withDeviceState.id)
          if (
            withDeviceState.installedLocally &&
            !localPluginKeys.has(catalogName) &&
            !localPluginKeys.has(catalogId) &&
            !localStoreDirs.some(dirName => storeDirMatchesPluginKey(dirName, withDeviceState.name))
          ) {
            return { ...withDeviceState, installedLocally: false }
          }
          return withDeviceState
        })
        const heldBack = holdBackInFlightMarketplaceInstalls({
          items: nextItems,
          installed: nextInstalledRaw,
          installingIds: installingMarketplacePluginIdsRef.current,
          authPluginKey: pendingLocalConnectorAuthRef.current?.target.pluginKey,
        })
        const nextInstalled = heldBack.installed
        setInstalledPlugins(previous =>
          sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
        )
        setPluginMarketplaceState(previous => {
          const items = heldBack.items
          if (sameMarketplaceItems(previous.items, items) && !previous.error) {
            return { ...previous, isLoading: false, error: null }
          }
          const cachedSnapshot = getPluginMarketplaceCache(marketplaceCacheKeyValue)
          if (cachedSnapshot) {
            setPluginMarketplaceCache(
              {
                ...cachedSnapshot,
                marketplaceItems: items,
                installedPlugins: nextInstalled,
                marketplaces: toMarketplaceOptions(
                  localState.marketplaces,
                  cloudMarketplaceAvailable,
                  t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
                ),
                deviceId: localState.deviceId || cachedSnapshot.deviceId,
                fetchedAt: Date.now(),
              },
              { persistImmediately: true }
            )
          }
          return { items, isLoading: false, error: null }
        })
        setIsOpenAiOfficialCatalogLoading(false)
        setIsMarketplaceRefreshing(false)
      })
    },
    [
      applyLocalMarketplaceState,
      cloudMarketplaceAvailable,
      localPluginApi,
      marketplaceCacheKeyValue,
      t,
    ]
  )

  const createdPluginSlug = (plugin: InstalledPluginItem) =>
    plugin.raw.spec.source.pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  const findOwnedMarketplacePlugin = (plugin: InstalledPluginItem) => {
    const slug = createdPluginSlug(plugin)
    return pluginMarketplaceState.items.find(
      item => item.accessRole === 'owner' && (item.name === slug || item.name === plugin.name)
    )
  }

  const listingTypeForPlugin = (plugin: InstalledPluginItem): 'plugin' | 'skill' => {
    const components = plugin.raw.spec.components
    const isSingleSkill =
      components.skills.length === 1 &&
      components.commands.length === 0 &&
      components.agents.length === 0 &&
      components.mcps.length === 0 &&
      components.hooks.length === 0 &&
      components.lsps.length === 0 &&
      components.monitors.length === 0 &&
      components.bins.length === 0
    return isSingleSkill ? 'skill' : 'plugin'
  }

  const applySubmissionToInstalledPlugin = (
    pluginId: string | number,
    submission: { id: number; status: string; reviewNote?: string }
  ) => {
    setInstalledPlugins(previous =>
      previous.map(candidate => {
        if (String(candidate.id) !== String(pluginId)) return candidate
        const updated: InstalledPlugin = {
          ...candidate.raw,
          spec: {
            ...candidate.raw.spec,
            sourcePayload: {
              ...(candidate.raw.spec.sourcePayload ?? {}),
              submissionId: submission.id,
              submissionStatus: submission.status,
              submissionReviewNote: submission.reviewNote ?? '',
            },
          },
        }
        return toInstalledPluginItem(updated)
      })
    )
  }

  const applyPublishedIdentityToInstalledPlugin = (
    pluginId: string | number,
    cloudPluginId: number,
    cloudReleaseId: number | null
  ) => {
    setInstalledPlugins(previous =>
      previous.map(candidate => {
        if (String(candidate.id) !== String(pluginId)) return candidate
        const updated: InstalledPlugin = {
          ...candidate.raw,
          spec: {
            ...candidate.raw.spec,
            sourcePayload: withPublishedPluginCloudLink(
              candidate.raw.spec.sourcePayload,
              cloudPluginId,
              cloudReleaseId
            ),
          },
        }
        return toInstalledPluginItem(updated)
      })
    )
  }

  const integratePersonalPublication = async (
    plugin: InstalledPluginItem,
    completed: PluginSubmissionCompleteResponse
  ): Promise<number> => {
    applySubmissionToInstalledPlugin(plugin.id, completed.submission)
    if (!completed.plugin) {
      throw new Error(
        t(
          'workbench.plugins_personal_source_publish_missing',
          '个人插件版本已上传，但服务端未返回个人插件记录，请重试。'
        )
      )
    }
    const cloudPluginId = Number(completed.plugin.id)
    const cloudReleaseId = completed.plugin.latestReleaseId ?? null
    try {
      await localPluginApi.linkPersonalPluginRelease(plugin.raw, cloudPluginId, cloudReleaseId)
    } catch {
      // Cloud submit already succeeded; keep publish successful if local link lags.
    }
    applyPublishedIdentityToInstalledPlugin(plugin.id, cloudPluginId, cloudReleaseId)
    if (completed.plugin.latestReleaseId) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        items: [
          {
            ...completed.plugin!,
            installed: true,
            installedPluginId: plugin.id,
            enabled: plugin.enabled,
            updateAvailable: false,
            currentDeviceInstallation: null,
          },
          ...previous.items.filter(item => item.id !== completed.plugin!.id),
        ],
        error: null,
      }))
    }
    return cloudPluginId
  }

  const openPublishCreatedPlugin = async (plugin: InstalledPluginItem) => {
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    setPluginPublishAccess(null)
    setPluginPublishTarget(null)
    setPluginPublishPreparing(true)
    const owned = findOwnedMarketplacePlugin(plugin)
    try {
      const ownedPersonalPluginId =
        owned?.accessRole === 'owner' && owned.visibility === 'personal'
          ? Number(owned.id)
          : undefined
      const [access] = await Promise.all([
        ownedPersonalPluginId
          ? pluginApi.getMarketplacePluginAccess(ownedPersonalPluginId)
          : Promise.resolve(null),
        refreshPublicationRequests(ownedPersonalPluginId),
      ])
      setPluginPublishAccess(access)
      setPluginPublishTarget(plugin)
    } catch (error) {
      setPluginOperationNotice({
        id: 'publication-readiness-load-failed-' + String(plugin.id),
        kind: 'error',
        message:
          error instanceof Error
            ? error.message
            : t(
                'workbench.plugins_publication_readiness_failed',
                '无法加载分享范围或发布申请，请重试。'
              ),
        actionLabel: t('common.retry', '重试'),
        onAction: () => {
          setPluginOperationNotice(null)
          void openPublishCreatedPlugin(plugin)
        },
      })
    } finally {
      setPluginPublishPreparing(false)
    }
  }

  const resolvePackablePublishTarget = (
    candidates: Array<string | null | undefined>,
    fallback?: InstalledPluginItem | null
  ): InstalledPluginItem | null => {
    const matched = findPackableCreatedPlugin(installedPlugins, candidates)
    if (matched) return matched
    if (fallback && isPackableCreatedPlugin(fallback)) return fallback
    return null
  }

  const openPackablePublish = (
    candidates: Array<string | null | undefined>,
    fallback?: InstalledPluginItem | null
  ) => {
    const target = resolvePackablePublishTarget(candidates, fallback)
    if (!target) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t(
          'workbench.plugins_publish_source_missing',
          '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
        ),
      }))
      return
    }
    void openPublishCreatedPlugin(target)
  }

  const publishCreatedPlugin = async (
    plugin: InstalledPluginItem,
    request: PluginPublishRequest
  ) => {
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    setIsUploadingPlugin(true)
    try {
      const ownedListing = findOwnedMarketplacePlugin(plugin)
      if (
        request.intent === 'restricted' &&
        ownedListing?.accessRole === 'owner' &&
        ownedListing.visibility === 'personal'
      ) {
        const access = await pluginApi.updateMarketplacePluginAccess(ownedListing.id, {
          scope: request.targets.length > 0 ? 'restricted' : 'private',
          targets: request.targets,
          allowCopy: request.targets.length > 0 && request.allowCopy,
        })
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(item =>
            item.id === ownedListing.id
              ? {
                  ...item,
                  allowCopy: access.allowCopy,
                  grantUserCount: access.targets.filter(target => target.entityType === 'user')
                    .length,
                  grantNamespaceCount: access.targets.filter(
                    target => target.entityType === 'namespace'
                  ).length,
                }
              : item
          ),
        }))
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        setPluginOperationNotice({
          id: 'share-saved-' + ownedListing.id,
          kind: 'success',
          message: t('workbench.plugins_share_saved_notice', '分享范围已更新。'),
        })
        return
      }

      const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
      if (request.intent === 'enterprise') {
        let sourcePluginId =
          ownedListing?.visibility === 'personal' ? Number(ownedListing.id) : null
        if (!sourcePluginId) {
          const personalPublication = await pluginApi.publishSubmission(file, {
            slug: createdPluginSlug(plugin),
            displayName: plugin.name,
            version: plugin.version || '0.1.0',
            listingType: listingTypeForPlugin(plugin),
            purpose: 'restricted_share',
            visibility: 'personal',
            targets: [],
            allowCopy: false,
          })
          sourcePluginId = await integratePersonalPublication(plugin, personalPublication)
        }
        const existingPublication = selectPrimaryPublication(
          matchingPublicationRequests(
            publicationRequests,
            sourcePluginId,
            createdPluginSlug(plugin)
          )
        )
        const snapshotMetadata = {
          requestedVersion: plugin.version || '0.1.0',
          releaseNotes: request.releaseNotes,
          testNotes: request.testNotes,
          riskDeclaration: { ...request.riskDeclaration },
        }
        const publication = existingPublication?.actionEligibility.canCreateRevision
          ? await pluginApi.publishPublicationRevision(
              existingPublication.id,
              file,
              snapshotMetadata,
              request.operationAttemptId
            )
          : await pluginApi.publishPublicationRequest(
              file,
              {
                sourcePluginId,
                slug: createdPluginSlug(plugin),
                displayName: plugin.name,
                listingType: listingTypeForPlugin(plugin),
                ...snapshotMetadata,
              },
              request.operationAttemptId
            )
        setPublicationRequests(previous => mergePublicationRequests(previous, [publication]))
        setMarketplaceRefreshTick(previous => previous + 1)
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        setPluginOperationNotice({
          id: 'publication-created-' + publication.id,
          kind: 'success',
          message: t(
            'workbench.plugins_publication_submitted_notice',
            '全员发布申请已提交；审核期间仍可继续编辑和使用个人插件。'
          ),
        })
        return
      }

      const completed = await pluginApi.publishSubmission(file, {
        slug: createdPluginSlug(plugin),
        displayName: plugin.name,
        version: plugin.version || '0.1.0',
        listingType: listingTypeForPlugin(plugin),
        purpose: 'restricted_share',
        visibility: request.visibility,
        targets: request.targets,
        allowCopy: request.allowCopy,
      })
      await integratePersonalPublication(plugin, completed)
      setPluginPublishTarget(null)
      setPluginPublishAccess(null)
      if (request.intent === 'restricted') {
        setPluginOperationNotice({
          id: 'share-created-' + completed.submission.id,
          kind: 'success',
          message: t('workbench.plugins_share_saved_notice', '分享范围已更新。'),
        })
        return
      }
      if (completed.submission.status === 'pending') {
        setPluginOperationNotice({
          id: `publish-pending-${completed.submission.id}`,
          kind: 'success',
          message: t(
            'workbench.plugins_publish_pending_notice',
            '已提交审核，通过后将出现在插件市场。'
          ),
        })
      } else if (completed.submission.status === 'approved') {
        setPluginOperationNotice({
          id: `publish-approved-${completed.submission.id}`,
          kind: 'success',
          message: t('workbench.plugins_publish_approved_notice', '发布成功。'),
        })
      }
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to publish local plugin')
      const versionExists = /version already exists/i.test(message)
      const ownedListing = findOwnedMarketplacePlugin(plugin)
      const friendly = versionExists
        ? t(
            'workbench.plugins_version_exists_hint',
            '该版本已存在，请先在插件清单中提升 version 后再发布。'
          )
        : /missing \.codex-plugin\/plugin\.json/i.test(message)
          ? t(
              'workbench.plugins_publish_source_missing',
              '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
            )
          : message
      // Keep publish failures dialog-scoped. Writing marketplace.error replaces the
      // entire catalog with a full-page error until the next successful refresh.
      setPluginPublishError(friendly)
      setPluginPublishShareRecovery(
        versionExists && canRecoverShareAfterVersionConflict(ownedListing ?? null)
      )
    } finally {
      setIsUploadingPlugin(false)
    }
  }

  const openPluginShare = async (plugin: PluginMarketplaceItem) => {
    setPluginSharePreparing(true)
    setPluginShareError(null)
    try {
      const access = await pluginApi.getMarketplacePluginAccess(plugin.id)
      setPluginShareState({ plugin, access })
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to load plugin access',
      }))
    } finally {
      setPluginSharePreparing(false)
    }
  }

  const openCreatedPluginAccess = async (plugin: InstalledPluginItem) => {
    const owned = findOwnedMarketplacePlugin(plugin)
    if (!owned || owned.visibility !== 'personal') {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t(
          'workbench.plugins_share_manage_hint',
          '仅用于管理个人插件的可见成员；扩大到组织或全部请使用「发布」。'
        ),
      }))
      return
    }
    await openPluginShare(owned)
  }

  const recoverPublishToShare = () => {
    const target = pluginPublishTarget
    if (!target) return
    setPluginPublishTarget(null)
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    void openCreatedPluginAccess(target)
  }

  const savePluginShare = async (request: PluginAccessUpdateRequest) => {
    if (!pluginShareState) return
    setPluginShareSaving(true)
    setPluginShareError(null)
    try {
      const access = await pluginApi.updateMarketplacePluginAccess(
        pluginShareState.plugin.id,
        request
      )
      setPluginMarketplaceState(previous => ({
        ...previous,
        items: previous.items.map(item =>
          item.id === pluginShareState.plugin.id
            ? {
                ...item,
                allowCopy: access.allowCopy,
                grantUserCount: access.targets.filter(target => target.entityType === 'user')
                  .length,
                grantNamespaceCount: access.targets.filter(
                  target => target.entityType === 'namespace'
                ).length,
              }
            : item
        ),
      }))
      setPluginShareState(null)
    } catch (error) {
      setPluginShareError(error instanceof Error ? error.message : 'Failed to save plugin access')
    } finally {
      setPluginShareSaving(false)
    }
  }

  const copyMarketplacePlugin = async (plugin: PluginMarketplaceItem) => {
    setPluginSharePreparing(true)
    setPluginMarketplaceState(previous => ({ ...previous, error: null }))
    try {
      const descriptor = await pluginApi.copyMarketplacePlugin(plugin.id)
      const installed = await localPluginApi.importMarketplaceCopy(descriptor)
      const installedItem = toInstalledPluginItem(installed)
      setInstalledPlugins(previous => [
        installedItem,
        ...previous.filter(item => String(item.id) !== String(installedItem.id)),
      ])
      notifyLocalPluginSkillsChanged()
      setSelectedMarketplacePluginId(null)
      setSelectedPluginId(installedItem.id)
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to copy plugin',
      }))
    } finally {
      setPluginSharePreparing(false)
    }
  }

  const searchPluginShareUsers = useCallback(
    (value: string) => pluginApi.searchPluginShareUsers(value).then(response => response.users),
    [pluginApi]
  )
  const searchPluginShareGroups = useCallback(
    (value: string) => pluginApi.searchPluginShareGroups(value).then(response => response.items),
    [pluginApi]
  )

  const togglePluginComponent = (id: string | number, componentKey: string, enabled: boolean) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return

    const previousStates = plugin.raw.spec.componentStates || {}
    const nextStates = { ...previousStates, [componentKey]: enabled }
    setInstalledPlugins(previous =>
      previous.map(item =>
        item.id === id
          ? {
              ...item,
              raw: {
                ...item.raw,
                spec: {
                  ...item.raw.spec,
                  componentStates: nextStates,
                },
              },
            }
          : item
      )
    )
    const updateApi =
      plugin.origin === 'created' || !plugin.raw.spec.pluginId
        ? localPluginApi.updateInstalledPlugin(id, {
            componentStates: { [componentKey]: enabled },
          })
        : pluginApi.updateInstalledPlugin(
            id,
            {
              componentStates: { [componentKey]: enabled },
            },
            currentDeviceId
          )
    updateApi
      .then(updated => {
        const nextItem = toInstalledPluginItem(updated)
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? nextItem : item)))
        track('plugin_enabled_changed', {
          enabled,
          scope: 'component',
          source: 'local',
        })
      })
      .catch(() => {
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? plugin : item)))
        track('operation_failed', { operation: 'plugin_toggle' })
      })
  }

  const changePluginAutoUpdatePolicy = (plugin: InstalledPluginItem, enabled: boolean) => {
    if (!isCloudManagedInstalledPlugin(plugin.raw)) return
    const updatePolicy = enabled ? 'auto' : 'manual'
    const pluginId = plugin.id
    setUpdatingPluginPolicyIds(previous => new Set(previous).add(pluginId))
    setPluginMarketplaceState(previous => ({ ...previous, error: null }))
    setInstalledPlugins(previous =>
      previous.map(item =>
        String(item.id) === String(pluginId)
          ? {
              ...item,
              raw: {
                ...item.raw,
                spec: { ...item.raw.spec, updatePolicy },
              },
            }
          : item
      )
    )

    pluginApi
      .updateInstalledPlugin(pluginId, { updatePolicy }, currentDeviceId)
      .then(updated => {
        const nextItem = toInstalledPluginItem(updated)
        setInstalledPlugins(previous =>
          previous.map(item => (String(item.id) === String(pluginId) ? nextItem : item))
        )
      })
      .catch(error => {
        const errorMessage = getErrorMessage(error, 'Unknown error')
        setInstalledPlugins(previous =>
          previous.map(item => (String(item.id) === String(pluginId) ? plugin : item))
        )
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: t('workbench.plugins_update_policy_failed', {
            error: errorMessage,
            defaultValue: `无法保存插件更新设置：${errorMessage}`,
          }),
        }))
      })
      .finally(() => {
        setUpdatingPluginPolicyIds(previous => {
          const next = new Set(previous)
          next.delete(pluginId)
          return next
        })
      })
  }

  const uninstallInstalledPlugin = (id: string | number, pluginName: string) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    const clearMarketplaceInstall = (
      previous: typeof pluginMarketplaceState
    ): typeof pluginMarketplaceState => ({
      ...previous,
      error: null,
      items: previous.items.map(item => {
        const sameInstallId =
          String(item.installedPluginId ?? '') === String(id) ||
          String(item.id) === String(id) ||
          String(item.remotePluginId ?? '') === String(id)
        const samePluginName =
          item.installed &&
          (item.name === pluginName ||
            item.displayName === pluginName ||
            item.name.toLowerCase() === String(pluginName).trim().toLowerCase())
        if (!sameInstallId && !samePluginName) return item
        return {
          ...item,
          installed: false,
          installedPluginId: null,
          enabled: false,
          currentDeviceInstallation: null,
        }
      }),
    })
    const markUninstalledLocally = () => {
      const nextInstalled = installedPluginsRef.current.filter(
        item => String(item.id) !== String(id)
      )
      const nextMarketplaceItems = clearMarketplaceInstall(pluginMarketplaceStateRef.current).items
      setInstalledPlugins(nextInstalled)
      setSelectedPluginId(current => (String(current) === String(id) ? null : current))
      setPluginMarketplaceState(clearMarketplaceInstall)
      const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
      if (cached) {
        setPluginMarketplaceCache({
          ...cached,
          marketplaceItems: nextMarketplaceItems,
          installedPlugins: nextInstalled,
          fetchedAt: Date.now(),
        })
      }
      setLocalConnectorAuthBySlug({})
      notifyLocalPluginSkillsChanged([
        String(id),
        pluginName,
        plugin?.raw.spec.source.pluginKey ?? '',
      ])
      setMarketplaceRefreshTick(previous => previous + 1)
      track('plugin_uninstalled', { source: 'local' })
    }
    const isAccountUninstallSettledError = (error: unknown) => {
      const message = getErrorMessage(error, '')
      return (
        /not found/i.test(message) ||
        /failed to synchronize/i.test(message) ||
        /PLUGIN_DEVICE_SYNC_FAILED/i.test(message)
      )
    }

    const noticeUninstallError = (id: string | number, error: unknown) => {
      const rawErrorMessage = getErrorMessage(
        error,
        t('workbench.plugins_uninstall_failed', '卸载失败，请稍后重试')
      )
      const errorMessage = humanizeMarketplaceUninstallError(rawErrorMessage, t)
      console.error('[Wework plugins] uninstall plugin failed', {
        pluginId: id,
        error: rawErrorMessage,
      })
      setPluginOperationNotice({
        id: `uninstall-error-${id}`,
        kind: 'error',
        message: errorMessage,
      })
    }

    if (!plugin) {
      // Local Codex marketplace installs are omitted from the merged installed list
      // once any cloud install exists, but they still appear as installed catalog rows.
      void localPluginApi
        .uninstallInstalledPlugin(id)
        .then(() => {
          markUninstalledLocally()
          setPluginOperationNotice({
            id: `uninstalled-${id}`,
            kind: 'success',
            message: t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
              name: pluginName,
              defaultValue: `${pluginName} 已卸载`,
            }),
          })
        })
        .catch((error: unknown) => {
          if (isAccountUninstallSettledError(error)) {
            markUninstalledLocally()
            setPluginOperationNotice({
              id: `uninstalled-${id}`,
              kind: 'success',
              message: t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
                name: pluginName,
                defaultValue: `${pluginName} 已卸载`,
              }),
            })
            return
          }
          noticeUninstallError(id, error)
        })
        .finally(() => {
          setUninstallingPluginIds(previous => {
            const next = new Set(previous)
            next.delete(id)
            return next
          })
        })
      return
    }

    void logoutLocalConnectorsForPlugin(plugin.raw)
      .catch(() => undefined)
      .then(() =>
        uninstallPluginIdentities(plugin.raw, id, currentDeviceId || undefined, {
          uninstallCloud: (pluginId, deviceId) =>
            pluginApi.uninstallInstalledPlugin(pluginId, deviceId),
          uninstallLocal: pluginId => localPluginApi.uninstallInstalledPlugin(pluginId),
        })
      )
      .then(outcome => {
        markUninstalledLocally()
        const warningDetails = pluginUninstallWarningDetails(outcome)
        setPluginOperationNotice({
          id: `uninstalled-${id}`,
          kind: warningDetails ? 'error' : 'success',
          message: warningDetails
            ? t(
                'workbench.plugins_uninstall_partial',
                '{{name}} 已从本机卸载，但部分清理失败：{{details}}',
                {
                  name: pluginName,
                  details: warningDetails,
                  defaultValue: `${pluginName} 已从本机卸载，但部分清理失败：${warningDetails}`,
                }
              )
            : t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
                name: pluginName,
                defaultValue: `${pluginName} 已卸载`,
              }),
        })
        if (warningDetails) {
          track('operation_failed', { operation: 'plugin_uninstall' })
        }
      })
      .catch((error: unknown) => {
        // Account Kind may already be inactive while device sync previously 502'd;
        // treat that as settled uninstall so the marketplace is not stuck "installed".
        if (isCloudManagedInstalledPlugin(plugin.raw) && isAccountUninstallSettledError(error)) {
          markUninstalledLocally()
          void localPluginApi.uninstallInstalledPlugin(id).catch(() => undefined)
          setPluginOperationNotice({
            id: `uninstalled-${id}`,
            kind: 'success',
            message: t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
              name: pluginName,
              defaultValue: `${pluginName} 已卸载`,
            }),
          })
          return
        }
        track('operation_failed', { operation: 'plugin_uninstall' })
        noticeUninstallError(id, error)
      })
      .finally(() => {
        setUninstallingPluginIds(previous => {
          const next = new Set(previous)
          next.delete(id)
          return next
        })
      })
  }

  const refreshMarketplace = () => {
    setBrowsingCategoryKey(null)
    skipGithubCatalogReconcileRef.current = false
    reconcileGithubCatalogRef.current = true
    setMarketplaceRefreshTick(previous => previous + 1)
  }

  const refreshLocalMarketplace = () => {
    setBrowsingCategoryKey(null)
    skipGithubCatalogReconcileRef.current = true
    reconcileGithubCatalogRef.current = false
    setMarketplaceRefreshTick(previous => previous + 1)
  }

  const addMarketplace = (event: FormEvent) => {
    event.preventDefault()
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
        applyLocalMarketplaceState(state)
        if (state.selectedMarketplaceId) {
          const selectedKey = localMarketplaceKey(state.selectedMarketplaceId)
          rememberMarketplaceKey(selectedKey)
          setSelectedMarketplaceKey(selectedKey)
          setMarketplaceSourceFilterKey(selectedKey)
        }
        setAddMarketForm({ source: '', gitRef: '', subPath: '' })
        setShowAddMarketDialog(false)
        refreshMarketplace()
      })
      .catch((error: Error) => {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: error.message,
        }))
      })
      .finally(() => {
        setIsAddingMarket(false)
      })
  }

  const { beginMarketplacePluginTrial, tryMarketplacePluginInChat } = usePluginInstallActions({
    installedPlugins,
    localPluginApi,
    t,
    setPluginMarketplaceState,
  })

  const prepareMarketplaceInstallItem = async (
    item: PluginMarketplaceItem
  ): Promise<PluginMarketplaceItem> => {
    const selectedDetail =
      selectedMarketplacePlugin?.id === item.id ? selectedMarketplacePluginDetail : null
    const detailedItem = withMarketplaceDetailComponents(item, selectedDetail)
    const requiresConnection =
      String(detailedItem.manifest?.authPolicy || '').toLowerCase() === 'on_install'
    const hasUsefulDetail =
      marketplaceComponentCount(detailedItem) > 0 &&
      (!requiresConnection || requiredConnectionNames(detailedItem).length > 0)
    if (hasUsefulDetail || !isLocalMarketplaceItem(item)) return detailedItem

    const marketplaceId = localMarketplaceIdFromItem(item)
    if (!marketplaceId) return detailedItem
    try {
      const detail = await localPluginApi.readMarketplacePluginDetail(marketplaceId, item.name)
      return withMarketplaceDetailComponents(item, toInstalledPluginItem(detail))
    } catch {
      return detailedItem
    }
  }

  const connectionNamesRequiredForInstall = useCallback(
    async (item: PluginMarketplaceItem): Promise<string[]> => {
      const requiredConnectors = (item.components.connectors ?? []).filter(
        connector => connector.authPolicy === 'on_install'
      )
      if (requiredConnectors.length === 0) return []

      const pluginName = item.displayName || item.name
      let connectedCloudSlugs = new Set<string>()
      let connectorAppNameBySlug = new Map<string, string>()
      if (
        cloudApiBaseUrl &&
        cloudToken &&
        requiredConnectors.some(connector => !isLocalConnector(connector))
      ) {
        try {
          const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
          connectedCloudSlugs = new Set(
            apps
              .filter(app => app.connection.status === 'connected')
              .map(app => app.slug.trim().toLowerCase())
          )
          connectorAppNameBySlug = new Map(
            apps
              .map(app => [app.slug.trim().toLowerCase(), app.name.trim()] as const)
              .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]))
          )
        } catch {
          // Treat unavailable connection state as requiring authorization.
        }
      }

      const pending = await Promise.all(
        requiredConnectors.map(async connector => {
          if (!isLocalConnector(connector)) {
            return connectedCloudSlugs.has(connector.slug.trim().toLowerCase())
              ? null
              : connector.slug
          }
          try {
            const health = await localConnectorAuthHealth({
              pluginKey: item.name,
              connectorSlug: connector.slug,
              localAuth: connector.localAuth ?? null,
            })
            return localQrManageActionFromHealth(health) === 'logout' ? null : connector.slug
          } catch {
            return connector.slug
          }
        })
      )

      return pending
        .filter((slug): slug is string => Boolean(slug))
        .map(slug =>
          connectorDisplayName(slug, {
            appName: connectorAppNameBySlug.get(slug.trim().toLowerCase()),
            pluginName,
          })
        )
    },
    [cloudApiBaseUrl, cloudToken]
  )

  const showDeviceDisconnectedNotice = (itemId: string | number) => {
    setPluginOperationNotice({
      id: `install-device-disconnected-${itemId}`,
      kind: 'error',
      message: t(
        'workbench.plugins_install_device_disconnected',
        '当前设备未连接到云端，暂时无法安装插件。请恢复连接后重试。'
      ),
      actionLabel: t('workbench.plugins_open_connection_settings', '连接设置'),
      onAction: () => {
        setPluginOperationNotice(null)
        navigateTo('/settings/connections')
      },
    })
  }

  const hasLiveRuntimeCloudConnection = async () => {
    if (!cloudApiBaseUrl || !currentDeviceId) return false
    return refreshLocalExecutorCloudConnectionStatus(cloudApiBaseUrl)
  }

  const installMarketplacePlugin = async (
    item: PluginMarketplaceItem,
    promptAfterInstall?: string
  ) => {
    const installLock = resolveMarketplacePluginLock(item)
    if (installLock) {
      setPluginOperationNotice({
        id: `install-locked-${item.id}`,
        kind: 'error',
        message: marketplacePluginLockLabel(installLock, t),
      })
      return
    }

    const installFromLocal = isLocalMarketplaceItem(item)
    const alreadyInstalled = Boolean(item.installed || item.installedLocally)
    const needsCloudPackagePush =
      !installFromLocal && (!alreadyInstalled || marketplaceItemCanRetryPluginUpdate(item))

    if (needsCloudPackagePush && !cloudToken) {
      const shouldLogin = window.confirm(
        t('workbench.plugins_login_required', '安装插件需要登录 Wegent 账户。是否前往登录？')
      )
      if (shouldLogin) {
        navigateTo('/settings/connections')
      }
      return
    }

    if (needsCloudPackagePush && !(await hasLiveRuntimeCloudConnection())) {
      showDeviceDisconnectedNotice(item.id)
      return
    }

    if (alreadyInstalled) {
      if (
        marketplaceItemCanRetryPluginUpdate(item) &&
        item.latestReleaseId &&
        item.installedPluginId
      ) {
        const confirmed = window.confirm(
          t(
            'workbench.plugins_update_confirm',
            '更新将同步到当前设备。若失败，本机将保留当前已安装版本。是否继续？'
          )
        )
        if (!confirmed) {
          return
        }
        setInstallingMarketplacePluginIds(previous => new Set(previous).add(item.id))
        pluginApi
          .updateMarketplacePlugin(item.installedPluginId, item.latestReleaseId, currentDeviceId)
          .then(plugin => {
            const next = toInstalledPluginItem(plugin)
            setInstalledPlugins(previous =>
              previous.map(candidate =>
                String(candidate.id) === String(next.id) ? next : candidate
              )
            )
            setPluginMarketplaceState(previous => ({
              ...previous,
              items: previous.items.map(candidate =>
                candidate.id === item.id
                  ? { ...candidate, updateAvailable: false, version: plugin.spec.version }
                  : candidate
              ),
            }))
          })
          .catch((error: Error) => {
            setPluginMarketplaceState(previous => ({ ...previous, error: error.message }))
          })
          .finally(() => {
            setInstallingMarketplacePluginIds(previous => {
              const next = new Set(previous)
              next.delete(item.id)
              return next
            })
          })
        return
      }
      const installed = findInstalledPluginForMarketplaceItem(item, installedPlugins)
      beginMarketplacePluginTrial(item, installed, promptAfterInstall)
      return
    }
    if (installingMarketplacePluginIds.has(item.id)) {
      return
    }

    if (preparingInstallPluginIdsRef.current.has(item.id)) return
    preparingInstallPluginIdsRef.current.add(item.id)

    // Open the confirm dialog immediately. Do not wait on plugin/read, connector-apps,
    // or health probes — that made Install feel broken (no UI for seconds).
    if (!promptAfterInstall) {
      setPendingInstall({
        item,
        requiredConnectionNames: requiredConnectionNames(item),
      })
    }

    void prepareMarketplaceInstallItem(item)
      .then(async preparedItem => {
        if (promptAfterInstall) {
          executeMarketplaceInstall({
            item: preparedItem,
            requiredConnectionNames: [],
            promptAfterInstall,
          })
          return
        }
        const names = await connectionNamesRequiredForInstall(preparedItem)
        setPendingInstall(previous => {
          if (!previous || String(previous.item.id) !== String(item.id)) return previous
          return {
            item: preparedItem,
            requiredConnectionNames: names,
          }
        })
      })
      .catch(() => {
        // Keep the immediately opened dialog; confirm still uses the list-row item.
      })
      .finally(() => {
        preparingInstallPluginIdsRef.current.delete(item.id)
      })
  }

  function executeMarketplaceInstall(install: PendingMarketplaceInstall | null = pendingInstall) {
    if (!install) return
    const { item: dialogItem, promptAfterInstall } = install
    if (installingMarketplacePluginIds.has(dialogItem.id)) return

    // Re-check lock against the latest catalog row. Stale-peek SWR can open the
    // confirm dialog before background plugin/list paints DISABLED_BY_ADMIN.
    const latestItem =
      pluginMarketplaceStateRef.current.items.find(
        candidate => String(candidate.id) === String(dialogItem.id)
      ) ?? dialogItem
    const installLock = resolveMarketplacePluginLock(latestItem)
    if (installLock) {
      setPendingInstall(null)
      setPluginOperationNotice({
        id: `install-locked-${latestItem.id}`,
        kind: 'error',
        message: marketplacePluginLockLabel(installLock, t),
      })
      return
    }

    const item = {
      ...latestItem,
      // Keep any connector detail already prepared into the dialog snapshot.
      components: dialogItem.components?.connectors?.length
        ? dialogItem.components
        : latestItem.components,
      manifest: {
        ...dialogItem.manifest,
        ...latestItem.manifest,
      },
    }

    const localMarketplaceId = localMarketplaceIdFromItem(item)
    const installFromLocal = localMarketplaceId !== null

    setPendingInstall(null)
    setInstallingMarketplacePluginIds(previous => new Set(previous).add(item.id))
    setPluginMarketplaceState(previous => ({
      ...previous,
      error: null,
    }))
    // Always re-prepare before connector auth + install. The confirm dialog opens
    // immediately with the list-row item; a fast confirm must not skip connector
    // detail that prepareMarketplaceInstallItem is still loading.
    const request = prepareMarketplaceInstallItem(item)
      .then(async preparedItem => {
        await ensureMarketplaceConnectors(preparedItem)
        return preparedItem
      })
      .then(preparedItem => {
        // Re-check lock after prepare/connectors — background refresh may have
        // painted DISABLED_BY_ADMIN while the dialog was open.
        const latest =
          pluginMarketplaceStateRef.current.items.find(
            candidate => String(candidate.id) === String(preparedItem.id)
          ) ?? preparedItem
        const lock = resolveMarketplacePluginLock(latest)
        if (lock) {
          throw Object.assign(new Error(marketplacePluginLockLabel(lock, t)), {
            code: 'MARKETPLACE_PLUGIN_LOCKED',
          })
        }
        return preparedItem
      })
      .then(async preparedItem => {
        if (installFromLocal) {
          const plugin = await localPluginApi.installAvailablePlugin(
            preparedItem.id,
            localMarketplaceId!
          )
          return { plugin, preparedItem }
        }
        if (!(await hasLiveRuntimeCloudConnection())) {
          throw Object.assign(new Error('Current device is disconnected'), {
            code: 'PLUGIN_DEVICE_DISCONNECTED',
          })
        }
        const response = await pluginApi.installMarketplacePlugin(preparedItem.id, currentDeviceId)
        return { plugin: response.plugin, preparedItem }
      })
      .then(async ({ plugin, preparedItem }) => {
        await ensureLocalConnectorsAfterInstall(preparedItem, plugin)
        return plugin
      })

    request
      .then(plugin => {
        const installed = toInstalledPluginItem(plugin)
        const deviceInstallation = installFromLocal
          ? null
          : currentDeviceInstallation(plugin, currentDeviceId)
        const deviceState = deviceInstallation?.state
        const installedOnCurrentDevice =
          installFromLocal ||
          deviceState === 'installed' ||
          plugin.spec.installState === 'installed' ||
          plugin.spec.installState === 'update_available'
        const deviceSyncPending =
          !installFromLocal &&
          !installedOnCurrentDevice &&
          (deviceState === 'pending' ||
            deviceState === 'downloading' ||
            deviceState === 'installing' ||
            deviceState === 'failed' ||
            !deviceInstallation)
        const nextMarketplaceItems = pluginMarketplaceStateRef.current.items.map(candidate =>
          candidate.id === item.id
            ? {
                ...candidate,
                // Account install succeeded; keep the row actionable even when
                // the current device acknowledgement is still catching up.
                installed: installedOnCurrentDevice || deviceSyncPending,
                installedLocally: installFromLocal || Boolean(candidate.installedLocally),
                enabled: Boolean(plugin.spec.enabled),
                installedPluginId: installed.id,
                currentDeviceInstallation: deviceInstallation,
                components: plugin.spec.components,
                // Keep marketplaceId from the catalog row. Installed-plugin
                // manifests omit it, and local market tabs filter by that field.
                manifest: {
                  ...candidate.manifest,
                  ...plugin.spec.manifest,
                  marketplaceId:
                    (typeof candidate.manifest?.marketplaceId === 'string'
                      ? candidate.manifest.marketplaceId
                      : null) ||
                    (typeof plugin.spec.manifest?.marketplaceId === 'string'
                      ? plugin.spec.manifest.marketplaceId
                      : null) ||
                    localMarketplaceIdFromItem(candidate),
                },
                interface: installFromLocal ? plugin.spec.interface : candidate.interface,
              }
            : candidate
        )
        const nextInstalledPlugins = [
          installed,
          ...installedPluginsRef.current.filter(candidate => candidate.id !== installed.id),
        ]
        const nextMarketplaceState = {
          ...pluginMarketplaceStateRef.current,
          items: nextMarketplaceItems,
          error: null,
        }
        // Keep refs in sync before the post-install refresh paints — effects can
        // read them before React commits the matching useState updates.
        installedPluginsRef.current = nextInstalledPlugins
        pluginMarketplaceStateRef.current = nextMarketplaceState
        const nextInstallingIds = new Set(installingMarketplacePluginIdsRef.current)
        nextInstallingIds.delete(item.id)
        installingMarketplacePluginIdsRef.current = nextInstallingIds
        setInstalledPlugins(nextInstalledPlugins)
        notifyLocalPluginSkillsChanged()
        setPluginMarketplaceState(nextMarketplaceState)
        // Drop the in-flight marker before refresh so hold-back does not clear the
        // optimistic installed row while the background catalog catch-up runs.
        setInstallingMarketplacePluginIds(nextInstallingIds)
        setPluginMarketplaceCache({
          cacheKey: marketplaceCacheKeyValue,
          marketplaceItems: nextMarketplaceItems,
          installedPlugins: nextInstalledPlugins,
          marketplaces: marketplacesRef.current,
          selectedMarketplaceKey: selectedMarketplaceKeyRef.current,
          deviceId: currentDeviceIdRef.current || '',
          fetchedAt: Date.now(),
        })
        track('plugin_installed', { source: installFromLocal ? 'local' : 'cloud' })
        setMarketplaceRefreshTick(previous => previous + 1)
        setPluginOperationNotice({
          id: `installed-${item.id}`,
          kind: deviceState === 'failed' ? 'error' : 'success',
          message:
            deviceState === 'failed'
              ? t(
                  'workbench.plugins_install_device_sync_retry',
                  '{{name}} 已保存，当前设备同步失败，可稍后重试安装',
                  {
                    name: item.displayName || item.name,
                    defaultValue: `${item.displayName || item.name} 已保存，当前设备同步失败，可稍后重试安装`,
                  }
                )
              : t('workbench.plugins_install_success_title', '{{name}} 已安装', {
                  name: item.displayName || item.name,
                  defaultValue: `${item.displayName || item.name} 已安装`,
                }),
        })
        if (
          promptAfterInstall &&
          queuePluginPromptTrial(installed.raw, promptAfterInstall, { openInNewChat: true })
        ) {
          navigateTo('/')
        }
      })
      .catch((error: unknown) => {
        if (Reflect.get(error as object, 'code') === 'PLUGIN_DEVICE_DISCONNECTED') {
          setPluginMarketplaceState(previous => ({ ...previous, error: null }))
          showDeviceDisconnectedNotice(item.id)
          return
        }
        const rawErrorMessage = getErrorMessage(
          error,
          t('workbench.plugins_install_failed', '安装失败，请稍后重试')
        )
        const errorMessage = humanizeMarketplaceInstallError(rawErrorMessage, t)
        console.error('[Wework plugins] install failed', {
          pluginId: item.id,
          pluginName: item.name,
          marketplaceId: localMarketplaceIdFromItem(item),
          installFromLocal,
          error: rawErrorMessage,
        })
        const syncSettled =
          /failed to synchronize/i.test(rawErrorMessage) ||
          /PLUGIN_DEVICE_SYNC_FAILED/i.test(rawErrorMessage) ||
          error instanceof LocalConnectorPluginSyncTimeoutError
        // Older backends 502 after Kind create; refresh so the row can show the
        // account install instead of leaving a permanent pink sync banner.
        if (syncSettled) {
          notifyLocalPluginSkillsChanged()
          setMarketplaceRefreshTick(previous => previous + 1)
          setPluginMarketplaceState(previous => ({ ...previous, error: null }))
          setPluginOperationNotice({
            id: `install-sync-${item.id}`,
            kind: 'error',
            message: t(
              'workbench.plugins_install_device_sync_retry',
              '{{name}} 已保存，当前设备同步失败，可稍后重试安装',
              {
                name: item.displayName || item.name,
                defaultValue: `${item.displayName || item.name} 已保存，当前设备同步失败，可稍后重试安装`,
              }
            ),
          })
          return
        }
        // Do not paint the pre-lock dialog snapshot back over a catalog row that
        // background refresh already marked DISABLED_BY_ADMIN.
        const lockedAbort = Reflect.get(error as object, 'code') === 'MARKETPLACE_PLUGIN_LOCKED'
        if (!lockedAbort) {
          setPluginMarketplaceState(previous => ({
            ...previous,
            items: previous.items.map(candidate => (candidate.id === item.id ? item : candidate)),
            error: null,
          }))
        } else {
          setPluginMarketplaceState(previous => ({ ...previous, error: null }))
        }
        track('operation_failed', { operation: 'plugin_install' })
        setPluginOperationNotice({
          id: `install-error-${item.id}`,
          kind: 'error',
          message: errorMessage,
        })
      })
      .finally(() => {
        setInstallingMarketplacePluginIds(previous => {
          const next = new Set(previous)
          next.delete(item.id)
          return next
        })
      })
  }

  const requestUninstallPlugin = (id: string | number, name: string) => {
    setPendingPluginUninstall({ id, name })
  }

  const marketplaceUninstallId = (item: PluginMarketplaceItem): string | number => {
    const linkedLocal = installedPlugins.find(plugin => {
      if (isCloudManagedInstalledPlugin(plugin.raw)) return false
      const cloudPluginId = linkedCloudPluginId(plugin.raw)
      return cloudPluginId !== null && String(cloudPluginId) === String(item.id)
    })
    if (linkedLocal) return linkedLocal.id
    if (item.installedPluginId !== null && item.installedPluginId !== undefined) {
      return item.installedPluginId
    }
    if (typeof item.manifest?.marketplaceId === 'string' && item.manifest.marketplaceId) {
      return `${item.name}@${item.manifest.marketplaceId}`
    }
    return item.id
  }

  const confirmUninstallPlugin = () => {
    if (!pendingPluginUninstall) return
    const { id, name } = pendingPluginUninstall
    setPendingPluginUninstall(null)
    setUninstallingPluginIds(previous => new Set(previous).add(id))
    uninstallInstalledPlugin(id, name)
  }

  const requestDeletePersonalPlugin = async (input: {
    pluginName: string
    displayName: string
    marketplacePath?: string | null
    installedId?: string | number | null
    cloudPluginId?: string | number | null
    deleteLocalSource?: boolean
  }) => {
    const normalizedPluginName = input.pluginName.trim().toLowerCase()
    const publication = matchingPublicationRequests(
      publicationRequests,
      input.cloudPluginId === null || input.cloudPluginId === undefined
        ? null
        : Number(input.cloudPluginId),
      normalizedPluginName
    ).find(candidate => !TERMINAL_PUBLICATION_STATUSES.has(candidate.status))
    const pending = {
      pluginName: input.pluginName,
      displayName: input.displayName,
      marketplacePath: input.marketplacePath?.trim() || null,
      installedId: input.installedId ?? null,
      cloudPluginId: input.cloudPluginId ?? null,
      deleteLocalSource: input.deleteLocalSource ?? true,
      impact: null,
      publication: publication ?? null,
    }
    setPendingPersonalPluginDelete(pending)
    if (pending.cloudPluginId === null) return
    try {
      const impact = await pluginApi.getMarketplacePluginDeleteImpact(pending.cloudPluginId)
      setPendingPersonalPluginDelete(current =>
        current && String(current.cloudPluginId) === String(pending.cloudPluginId)
          ? { ...current, impact }
          : current
      )
    } catch {
      setPendingPersonalPluginDelete(null)
      setPluginOperationNotice({
        id: `delete-impact-error-${pending.pluginName}`,
        kind: 'error',
        message: t('workbench.plugins_delete_impact_failed', '无法检查插件使用情况，请稍后重试'),
      })
    }
  }

  const confirmDeletePersonalPlugin = async () => {
    if (!pendingPersonalPluginDelete || isDeletingPersonalPlugin) return
    const pending = pendingPersonalPluginDelete
    if (pending.cloudPluginId !== null && !pending.impact) return
    setIsDeletingPersonalPlugin(true)
    try {
      if (pending.publication) {
        if (!pending.publication.actionEligibility.canWithdraw) {
          throw new Error(
            t(
              'workbench.plugins_delete_publication_cannot_withdraw',
              '当前全员发布申请不能撤回，暂时无法删除个人原件。'
            )
          )
        }
        const withdrawn = await pluginApi.withdrawPublicationRequest(
          pending.publication.id,
          pending.publication.currentRevision
        )
        setPublicationRequests(previous => mergePublicationRequests(previous, [withdrawn]))
      }
      if (pending.cloudPluginId !== null) {
        await pluginApi.deleteMarketplacePlugin(pending.cloudPluginId, {
          impactRevision: pending.impact!.impactRevision,
          revokeAndDelete:
            pending.impact!.affectedUserCount > 0 || pending.impact!.sharedTargetCount > 0,
        })
      }
      if (pending.installedId !== null) {
        const installed = installedPluginsRef.current.find(
          plugin => String(plugin.id) === String(pending.installedId)
        )
        if (installed) await logoutLocalConnectorsForPlugin(installed.raw).catch(() => undefined)
        await localPluginApi.uninstallInstalledPlugin(pending.installedId)
      }
      if (pending.deleteLocalSource) {
        await localPluginApi.deletePersonalPlugin(
          pending.pluginName,
          pending.marketplacePath ?? undefined
        )
      }

      const normalizedName = pending.pluginName.trim().toLowerCase()
      const matchesInstalled = (plugin: InstalledPluginItem) =>
        plugin.distribution === 'personal' &&
        [plugin.raw.spec.source.pluginKey, plugin.raw.spec.manifest.name, plugin.name]
          .filter(Boolean)
          .some(name => String(name).trim().toLowerCase() === normalizedName)
      const matchesMarketplace = (item: PluginMarketplaceItem) =>
        (pending.cloudPluginId !== null && String(item.id) === String(pending.cloudPluginId)) ||
        (isPersonalMarketplaceId(marketplaceItemMarketplaceId(item) || '') &&
          item.name.trim().toLowerCase() === normalizedName)
      const nextInstalled = installedPluginsRef.current.filter(plugin => !matchesInstalled(plugin))
      setInstalledPlugins(nextInstalled)
      setPluginMarketplaceState(previous => ({
        ...previous,
        items: previous.items.filter(item => !matchesMarketplace(item)),
        error: null,
      }))
      const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
      if (cached) {
        setPluginMarketplaceCache({
          ...cached,
          marketplaceItems: cached.marketplaceItems.filter(item => !matchesMarketplace(item)),
          installedPlugins: cached.installedPlugins.filter(plugin => !matchesInstalled(plugin)),
          fetchedAt: Date.now(),
        })
      }
      setSelectedPluginId(null)
      setSelectedMarketplacePluginId(null)
      setPendingPersonalPluginDelete(null)
      notifyLocalPluginSkillsChanged()
      refreshLocalMarketplace()
      setPluginOperationNotice({
        id: `deleted-${pending.pluginName}`,
        kind: 'success',
        message: t('workbench.plugins_delete_success', '{{name}} 已删除', {
          name: pending.displayName,
          defaultValue: `${pending.displayName} 已删除`,
        }),
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && pending.cloudPluginId !== null) {
        try {
          const impact = await pluginApi.getMarketplacePluginDeleteImpact(pending.cloudPluginId)
          setPendingPersonalPluginDelete(current =>
            current && String(current.cloudPluginId) === String(pending.cloudPluginId)
              ? { ...current, impact }
              : current
          )
          setPluginOperationNotice({
            id: `delete-impact-changed-${pending.pluginName}`,
            kind: 'error',
            message: t(
              'workbench.plugins_delete_impact_changed',
              '插件使用情况已变化，请确认最新影响后重试'
            ),
          })
          return
        } catch {
          // Fall through to the recoverable generic error below.
        }
      }
      console.error('[Wework plugins] delete personal plugin failed', {
        pluginName: pending.pluginName,
        marketplacePath: pending.marketplacePath,
        error: getErrorMessage(error, 'unknown error'),
      })
      setPluginOperationNotice({
        id: `delete-error-${pending.pluginName}`,
        kind: 'error',
        message: pending.publication
          ? t(
              'workbench.plugins_delete_publication_withdraw_failed',
              '全员发布申请未能安全撤回，个人插件未删除。请查看申请状态后重试。'
            )
          : t('workbench.plugins_delete_failed', '删除插件失败，请稍后重试'),
      })
    } finally {
      setIsDeletingPersonalPlugin(false)
    }
  }

  const promptLocalConnectorAuth = (input: { target: LocalConnectorAuthTarget; title: string }) =>
    new Promise<void>((resolve, reject) => {
      setPendingLocalConnectorAuth({
        target: input.target,
        title: input.title,
        resolve,
        reject,
      })
    })

  const ensureMarketplaceConnectors = async (item: PluginMarketplaceItem) => {
    const required = (item.components.connectors ?? []).filter(
      connector => connector.authPolicy === 'on_install'
    )
    const oauthRequired = required.filter(connector => !isLocalConnector(connector))
    if (oauthRequired.length === 0) return
    if (!cloudApiBaseUrl || !cloudToken) {
      // OpenAI/local plugins may declare host-agnostic connector ids. Do not block
      // install just because Wegent cloud OAuth is unavailable for those rows.
      if (isLocalMarketplaceItem(item)) return
      throw new Error(
        t('workbench.plugins_connector_cloud_required', '请先连接 Wegent 账户再授权 GitHub')
      )
    }
    const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
    for (const requirement of oauthRequired) {
      const app = apps.find(
        candidate => candidate.slug.trim().toLowerCase() === requirement.slug.trim().toLowerCase()
      )
      if (!app) {
        // Codex/OpenAI marketplace connectors often use opaque ids that are not
        // Wegent connector-apps. Skip host OAuth there; runtime auth still applies.
        if (isLocalMarketplaceItem(item)) continue
        throw new Error(t('workbench.plugins_connector_unavailable', '所需应用连接暂不可用'))
      }
      if (app.connection.status === 'connected') continue
      const noticeId = `authorization-${requirement.slug}`
      setPluginOperationNotice({
        id: noticeId,
        kind: 'authorization',
        message: t(
          'workbench.plugins_finish_connecting_in_browser',
          '请在浏览器中完成 {{name}} 连接',
          {
            name: app.name,
            defaultValue: `请在浏览器中完成 ${app.name} 连接`,
          }
        ),
        iconUrl: app.icon_url,
      })
      try {
        await authorizeWegentConnector(
          cloudApiBaseUrl,
          cloudToken,
          requirement.slug,
          openCloudAuthorizationWindow
        )
      } finally {
        setPluginOperationNotice(current => (current?.id === noticeId ? null : current))
      }
    }
  }

  const ensureLocalConnectorsAfterInstall = async (
    item: PluginMarketplaceItem,
    plugin: InstalledPlugin
  ) => {
    const listedConnectors = item.components.connectors ?? []
    const installedConnectors = plugin.spec.components.connectors ?? []
    const connectors = listedConnectors.length > 0 ? listedConnectors : installedConnectors
    const required = connectors.filter(
      connector => connector.authPolicy === 'on_install' && isLocalConnector(connector)
    )
    if (required.length === 0) return

    const pluginKey = plugin.spec.source.pluginKey || item.name
    const displayName = plugin.spec.displayName || item.displayName || item.name

    for (const connector of required) {
      const target: LocalConnectorAuthTarget = {
        pluginKey,
        connectorSlug: connector.slug,
        localAuth: connector.localAuth ?? null,
      }
      try {
        const health = await waitForLocalConnectorAuthAvailability(target)
        if (health.status === 'ok') continue
      } catch (error) {
        if (error instanceof LocalConnectorPluginSyncTimeoutError) throw error
        // Fall through to local login when health or tool discovery fails.
      }
      try {
        await promptLocalConnectorAuth({
          target,
          title: isLocalBrowserConnector(connector)
            ? t('workbench.plugins_local_browser_install_title', {
                defaultValue: `授权 ${displayName}`,
                name: displayName,
              })
            : t('workbench.plugins_local_qr_install_title', {
                defaultValue: `扫码登录 ${displayName}`,
                name: displayName,
              }),
        })
      } catch (error) {
        const pluginId =
          typeof plugin.metadata.labels === 'object' && plugin.metadata.labels
            ? (plugin.metadata.labels as Record<string, unknown>).id
            : plugin.spec.pluginId
        if (pluginId !== undefined && pluginId !== null && String(pluginId).length > 0) {
          try {
            await (localMarketplaceIdFromItem(item)
              ? localPluginApi.uninstallInstalledPlugin(pluginId as string | number)
              : pluginApi.uninstallInstalledPlugin(pluginId as string | number, currentDeviceId))
          } catch {
            // Keep original auth error if uninstall cleanup fails.
          }
        }
        throw error instanceof Error
          ? error
          : new Error(t('workbench.plugins_local_auth_cancelled', '已取消授权，安装已终止'))
      }
    }
  }

  const managePluginConnector = async (
    slug: string,
    plugin?: InstalledPluginItem | PluginMarketplaceItem | null
  ) => {
    const reportDetailError = (message: string) => {
      const pluginId =
        selectedMarketplacePluginId ??
        selectedPluginId ??
        (plugin && 'id' in plugin ? plugin.id : null)
      if (pluginId == null) return
      setPluginDetailActionError({ pluginId, message })
    }
    const connectors =
      plugin && 'raw' in plugin
        ? (plugin.raw.spec.components.connectors ?? [])
        : plugin && 'components' in plugin
          ? (plugin.components.connectors ?? [])
          : []
    const localConnector = connectors.find(
      connector => connector.slug === slug && isLocalConnector(connector)
    )
    if (localConnector) {
      const pluginKey =
        plugin && 'raw' in plugin
          ? plugin.raw.spec.source.pluginKey
          : plugin && 'name' in plugin
            ? String(plugin.name)
            : slug
      const displayName =
        plugin && 'raw' in plugin
          ? plugin.raw.spec.displayName || pluginKey
          : plugin && 'displayName' in plugin
            ? String(plugin.displayName || plugin.name)
            : pluginKey
      const target: LocalConnectorAuthTarget = {
        pluginKey,
        connectorSlug: slug,
        localAuth: localConnector.localAuth ?? null,
      }

      let action: 'logout' | 'login' = 'login'
      try {
        const health = await localConnectorAuthHealth(target)
        action = localQrManageActionFromHealth(health)
      } catch {
        // Keep login when the health probe fails.
      }

      if (action === 'logout') {
        const confirmed = window.confirm(
          t('workbench.plugins_local_auth_logout_confirm', {
            defaultValue: `确定退出「${displayName}」登录？退出后需要重新授权。`,
            name: displayName,
          })
        )
        if (!confirmed) return
        try {
          await localConnectorAuthLogout(target)
          setLocalConnectorAuthBySlug(previous => ({ ...previous, [slug]: 'disconnected' }))
        } catch (error) {
          reportDetailError(
            error instanceof Error
              ? error.message
              : t('workbench.plugins_local_auth_logout_failed', '退出登录失败')
          )
        }
        return
      }

      try {
        await promptLocalConnectorAuth({
          target,
          title: isLocalBrowserConnector(localConnector)
            ? t('workbench.plugins_local_browser_login_title', {
                defaultValue: `授权 ${displayName}`,
                name: displayName,
              })
            : t('workbench.plugins_local_qr_login_title', {
                defaultValue: `扫码登录 ${displayName}`,
                name: displayName,
              }),
        })
        setLocalConnectorAuthBySlug(previous => ({ ...previous, [slug]: 'connected' }))
      } catch (error) {
        reportDetailError(
          error instanceof Error
            ? error.message
            : t('workbench.plugins_local_auth_cancelled', '已取消授权')
        )
      }
      return
    }

    if (!pluginUsesWegentConnectorOAuth(plugin)) {
      reportDetailError(
        t(
          'workbench.plugins_connector_chat_auth',
          '此插件通过对话授权 GitHub，请在聊天中按提示完成登录。'
        )
      )
      return
    }

    if (!cloudApiBaseUrl || !cloudToken) {
      reportDetailError(
        t('workbench.plugins_connector_cloud_required', '请先连接 Wegent 账户再授权 GitHub')
      )
      return
    }
    try {
      const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
      const app = apps.find(
        candidate => candidate.slug.trim().toLowerCase() === slug.trim().toLowerCase()
      )
      if (!app) {
        reportDetailError(t('workbench.plugins_connector_unavailable', '所需应用连接暂不可用'))
        return
      }
      if (app.connection.status === 'connected') {
        navigateTo('/settings/connections')
        return
      }
      await authorizeWegentConnector(
        cloudApiBaseUrl,
        cloudToken,
        app.slug,
        openCloudAuthorizationWindow
      )
    } catch (error) {
      reportDetailError(error instanceof Error ? error.message : 'Connector authorization failed')
    }
  }

  useEffect(() => {
    let isCurrent = true
    const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
    const hasCachedCatalog = Boolean(cached?.marketplaceItems.length)
    const isExplicitRefresh = marketplaceRefreshTick > lastMarketplaceRefreshTickRef.current
    if (isExplicitRefresh) {
      lastMarketplaceRefreshTickRef.current = marketplaceRefreshTick
    }

    const deviceIdHint = cached?.deviceId || currentDeviceIdRef.current || undefined
    const localReadParams = { mergeAllMarketplaces: true as const }
    const peekedLocalState = !isExplicitRefresh
      ? peekLocalCodexPluginsReadState(localReadParams)
      : null
    const hasDurablePeek = Boolean(peekedLocalState?.marketplaceItems.length)
    const hasWarmOpenAiCatalog = hasOpenAiOfficialCatalog(
      mergeWarmMarketplaceItems(cached, peekedLocalState)
    )

    setIsOpenAiOfficialCatalogLoading(!hasWarmOpenAiCatalog)

    if (!hasCachedCatalog && !hasDurablePeek) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        isLoading: previous.items.length === 0,
        error: null,
      }))
    } else {
      // Cache-first / durable-peek: keep the catalog mounted while revalidating.
      // Flipping isLoading made action buttons vanish mid-click and flashed empty tabs.
      // Silent background revalidate when we already have a painted/cached catalog —
      // returning from background must not look like a full marketplace reload.
      const alreadyPainted =
        pluginMarketplaceStateRef.current.items.length > 0 || hasCachedCatalog || hasDurablePeek
      if (isExplicitRefresh) {
        setIsMarketplaceRefreshing(true)
      } else if (alreadyPainted) {
        setIsMarketplaceRefreshing(false)
      } else {
        setIsMarketplaceRefreshing(true)
      }
      setPluginMarketplaceState(previous => ({
        ...previous,
        isLoading: false,
        error: null,
        ...(previous.items.length === 0
          ? {
              items: mergeWarmMarketplaceItems(cached, peekedLocalState),
            }
          : {}),
      }))
      const warmInstalled = mergeWarmInstalledPlugins(cached, peekedLocalState)
      if (cached || warmInstalled.length > 0) {
        // Account cache owns cloud rows; durable peek still owns OpenAI/local
        // installs. Cache-only replacement hid GitHub on OpenAI官方 when the
        // account snapshot had cloud plugins but an empty official strip.
        setInstalledPlugins(previous =>
          sameInstalledPlugins(previous, warmInstalled) ? previous : warmInstalled
        )
      }
      if (peekedLocalState && marketplacesRef.current.length === 0) {
        applyLocalMarketplaceState(peekedLocalState)
      }
    }

    const hasGithubMarketplace = (cached?.marketplaces ?? marketplacesRef.current).some(
      entry => entry.kind === 'local' && /^https?:\/\/github\.com\//i.test(entry.path || '')
    )
    if ((!hasCachedCatalog && !hasDurablePeek) || isExplicitRefresh) {
      setMarketplaceLoadingMessage(
        hasGithubMarketplace
          ? isExplicitRefresh
            ? t('workbench.plugins_refreshing_github_marketplace', '正在刷新 GitHub 插件市场')
            : t(
                'workbench.plugins_syncing_github_marketplace',
                '正在同步 GitHub 插件市场，首次添加时需要 clone 仓库。'
              )
          : isExplicitRefresh
            ? t('workbench.plugins_refreshing_marketplace', '正在刷新插件市场')
            : t('workbench.plugins_loading_marketplace', '正在加载插件市场')
      )
    }
    // Catalog loads stay query-agnostic; search filters client-side from the cached list.
    // Reconcile Wework official, enterprise, and personal-created first. GitHub
    // plugin/list is last because it shares the Codex app-server lock with
    // plugin/install.
    const membershipPromise = localPluginApi.listInstalledPlugins({ refresh: true })
    const localPromise = Promise.resolve(peekedLocalState)
    // Use a known device id when available (cache / prior load). Otherwise start cloud
    // immediately for progressive first paint; a device-scoped pass follows once local
    // resolves the device id.
    const cloudPromise = cloudMarketplaceAvailable
      ? pluginApi.listMarketplacePlugins({
          deviceId: deviceIdHint || peekedLocalState?.deviceId,
        })
      : Promise.resolve({ items: [] as PluginMarketplaceItem[] })
    const installedPromise = pluginApi
      .listInstalledPlugins(deviceIdHint || peekedLocalState?.deviceId)
      .catch(() => ({ items: [] as InstalledPlugin[] }))

    // Live plugin/installed membership. Peek / plugin/list must not satisfy this.
    let liveLocalInstalledForMerge: InstalledPlugin[] | null = null

    // Only the applied live catalog may open GitHub plugin/list. Membership /
    // peek / warm-cache paints must not: they can look like "no device gap"
    // while the cloud row with pending is still in flight.
    const markAutoSyncInventoryReady = () => {
      if (!isCurrent) return
      setLocalInstalledStateReadyKey(marketplaceCacheKeyValue)
    }

    const applyCatalogSnapshot = (
      cloudItems: PluginMarketplaceItem[],
      cloudInstalled: InstalledPlugin[],
      localState: Awaited<ReturnType<typeof localPluginApi.readState>> | null,
      options?: {
        preferExistingOnSameSignature?: boolean
        keepLoadingWhenEmpty?: boolean
        deferInventoryReady?: boolean
      }
    ) => {
      const preferredLocal =
        localState && (peekedLocalState == null || localState !== peekedLocalState)
          ? localState.installedPlugins
          : (liveLocalInstalledForMerge ??
            localState?.installedPlugins ??
            installedPluginsRef.current.map(plugin => plugin.raw))
      const nextInstalledRaw = mergeInstalledPlugins(
        cloudInstalled,
        preferredLocal,
        localState?.deviceId || deviceIdHint || currentDeviceIdRef.current || ''
      ).map(toInstalledPluginItem)

      const cachedMarketplaceItems =
        getPluginMarketplaceCache(marketplaceCacheKeyValue)?.marketplaceItems ?? []
      const previousMarketplaceItems =
        pluginMarketplaceStateRef.current.items.length > 0
          ? pluginMarketplaceStateRef.current.items
          : cachedMarketplaceItems
      const localRows = mergeDiskPersonalIntoLocalRows(
        preferNonEmptyCatalogRows(
          localState?.marketplaceItems,
          cachedMarketplaceItems.filter(isCodexCatalogItem)
        ),
        mergeDiskPersonalIntoLocalRows(
          diskPersonalItemsForMerge ?? [],
          previousMarketplaceItems.filter(
            item => marketplacePluginDistribution(item) === 'personal'
          )
        )
      )
      const resolvedCloudItems = preferNonEmptyCatalogRows(
        cloudItems,
        nonCodexCatalogItems(previousMarketplaceItems)
      )
      const retained = retainMarketplaceInstalledState({
        previousItems: previousMarketplaceItems,
        nextItems: mergeMarketplaceCatalog(
          resolvedCloudItems,
          localRows,
          nextInstalledRaw.map(plugin => plugin.raw)
        ),
        previousInstalled: installedPluginsRef.current,
        nextInstalled: nextInstalledRaw,
        previousStateMatchesScope: marketplaceStateCacheKeyRef.current === marketplaceCacheKeyValue,
      })
      const heldBack = holdBackInFlightMarketplaceInstalls({
        items: retained.items,
        installed: retained.installed,
        installingIds: installingMarketplacePluginIdsRef.current,
        authPluginKey: pendingLocalConnectorAuthRef.current?.target.pluginKey,
      })
      const nextInstalled = heldBack.installed
      const mergedItems = heldBack.items
      if (mergedItems.length === 0) {
        const previousItems =
          pluginMarketplaceStateRef.current.items.length > 0
            ? pluginMarketplaceStateRef.current.items
            : cachedMarketplaceItems
        if (previousItems.length > 0) {
          setPluginMarketplaceState(previous =>
            previous.isLoading || previous.error
              ? { ...previous, isLoading: false, error: null }
              : previous
          )
          if (!options?.deferInventoryReady) markAutoSyncInventoryReady()
          return
        }
      }
      setInstalledPlugins(previous =>
        sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
      )
      setPluginMarketplaceState(previous => {
        if (
          options?.preferExistingOnSameSignature &&
          sameMarketplaceItems(previous.items, mergedItems) &&
          !previous.error
        ) {
          return {
            ...previous,
            isLoading: mergedItems.length === 0 && Boolean(options.keepLoadingWhenEmpty),
            error: null,
          }
        }
        return {
          items: mergedItems,
          isLoading: mergedItems.length === 0 && Boolean(options?.keepLoadingWhenEmpty),
          error: null,
        }
      })

      const nextMarketplaces =
        localState != null
          ? toMarketplaceOptions(
              localState.marketplaces,
              cloudMarketplaceAvailable,
              t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
            )
          : marketplacesRef.current

      setPluginMarketplaceCache(
        {
          cacheKey: marketplaceCacheKeyValue,
          marketplaceItems: mergedItems,
          installedPlugins: nextInstalled,
          marketplaces: nextMarketplaces,
          selectedMarketplaceKey: selectedMarketplaceKeyRef.current,
          deviceId: localState?.deviceId || deviceIdHint || currentDeviceIdRef.current || '',
          fetchedAt: Date.now(),
        },
        { persistImmediately: true }
      )
      if (!options?.deferInventoryReady) markAutoSyncInventoryReady()
    }

    // Paint whichever side arrives first so a slow Codex plugin/list (~10s remote
    // refresh) cannot block an already-fast cloud marketplace response, and vice versa.
    let catalogSettled = false
    let localStateForMerge: Awaited<ReturnType<typeof localPluginApi.readState>> | null = null
    let cloudItemsForMerge: PluginMarketplaceItem[] | null = null
    let cloudInstalledForMerge: InstalledPlugin[] | null = null
    let diskPersonalItemsForMerge: PluginMarketplaceItem[] | null = null

    const paintPartialCatalog = (options: {
      cloudItems?: PluginMarketplaceItem[]
      cloudInstalled?: InstalledPlugin[]
      localState?: Awaited<ReturnType<typeof localPluginApi.readState>> | null
      liveLocalInstalled?: InstalledPlugin[]
      diskPersonalItems?: PluginMarketplaceItem[]
      keepRefreshing: boolean
      ignoreSettled?: boolean
    }) => {
      if (!isCurrent || (catalogSettled && !options.ignoreSettled)) return
      const localState = options.localState ?? null
      if (options.liveLocalInstalled) {
        liveLocalInstalledForMerge = options.liveLocalInstalled
      }
      if (localState) {
        localStateForMerge = localState
        // A successful live readState snapshot is authoritative, including an
        // empty install list after the user uninstalls the last package.
        if (peekedLocalState == null || localState !== peekedLocalState) {
          liveLocalInstalledForMerge = localState.installedPlugins
        }
        setCurrentDeviceId(localState.deviceId)
        applyLocalMarketplaceState(localState)
        const selectedKey = localState.selectedMarketplaceId
          ? localMarketplaceKey(localState.selectedMarketplaceId)
          : ''
        initialMarketplaceLoadKeyRef.current = selectedKey
      }
      if (options.cloudItems && options.cloudItems.length > 0) {
        cloudItemsForMerge = options.cloudItems
      }
      if (options.cloudInstalled) {
        cloudInstalledForMerge = options.cloudInstalled
      }
      if (options.diskPersonalItems) {
        diskPersonalItemsForMerge = options.diskPersonalItems
      }
      // Cloud can arrive before Codex marketplaces; seed the cloud tab so the catalog
      // is not replaced by the empty "cloud unavailable" empty-state.
      if (options.cloudItems && !localStateForMerge && marketplacesRef.current.length === 0) {
        const seeded = toMarketplaceOptions(
          [],
          cloudMarketplaceAvailable,
          t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
        )
        if (seeded.length > 0) {
          setMarketplaces(seeded)
          const cloudKey = cloudMarketplaceAvailable ? cloudMarketplaceKey() : ''
          setSelectedMarketplaceKey(
            current =>
              current ||
              (cloudKey && seeded.some(option => option.key === cloudKey) ? cloudKey : '') ||
              seeded[0]?.key ||
              ''
          )
        }
      }
      if (
        options.diskPersonalItems?.length &&
        !localStateForMerge &&
        marketplacesRef.current.length === 0
      ) {
        const seeded = toMarketplaceOptions(
          [
            {
              id: WEWORK_PERSONAL_MARKETPLACE_ID,
              name: t('workbench.plugins_distribution_personal', '个人创建'),
              path: '',
            },
          ],
          cloudMarketplaceAvailable,
          t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
        )
        if (seeded.length > 0) {
          setMarketplaces(seeded)
          const cloudKey = cloudMarketplaceAvailable ? cloudMarketplaceKey() : ''
          setSelectedMarketplaceKey(
            current =>
              current ||
              (cloudKey && seeded.some(option => option.key === cloudKey) ? cloudKey : '') ||
              seeded[0]?.key ||
              ''
          )
        }
      }

      // Only reuse durable/in-flight data for the current cache key. React refs can
      // still hold the previous account for one frame after a key switch.
      const cachedSnapshot = getPluginMarketplaceCache(marketplaceCacheKeyValue)
      const hasCachedSnapshot = cachedSnapshot != null
      const cachedMarketplaceItems = cachedSnapshot?.marketplaceItems ?? []
      const cachedCloudItems = cachedMarketplaceItems.filter(item => !isCodexCatalogItem(item))
      const cachedInstalledRaw = (cachedSnapshot?.installedPlugins ?? []).map(plugin => plugin.raw)
      const cachedLocalItems = cachedMarketplaceItems.filter(isCodexCatalogItem)
      const previousItems =
        pluginMarketplaceStateRef.current.items.length > 0
          ? pluginMarketplaceStateRef.current.items
          : cachedMarketplaceItems
      const localRows = mergeDiskPersonalIntoLocalRows(
        preferNonEmptyCatalogRows(localStateForMerge?.marketplaceItems, cachedLocalItems),
        mergeDiskPersonalIntoLocalRows(
          diskPersonalItemsForMerge ?? [],
          previousItems.filter(item => marketplacePluginDistribution(item) === 'personal')
        )
      )
      // Never reuse the prior account's React state. A same-device local snapshot may
      // still contribute packages that are physically installed on this device.
      const previousInstalledRaw = hasCachedSnapshot
        ? cachedInstalledRaw
        : (localStateForMerge?.installedPlugins ?? [])
      const localInstalledForMerge =
        liveLocalInstalledForMerge ??
        resolveProgressiveLocalInstalledRaw({
          hasCachedSnapshot,
          cachedInstalledRaw,
          localInstalledRaw: localStateForMerge?.installedPlugins,
          localStateIsPeek:
            peekedLocalState != null &&
            localStateForMerge != null &&
            localStateForMerge === peekedLocalState,
          cachedDeviceId: cachedSnapshot?.deviceId,
          localDeviceId: localStateForMerge?.deviceId,
        })
      // Local-first paint must not blank cloud installs for THIS account. Never keep
      // prior-account strip rows when the current key has no warm snapshot.
      const cloudInstalled =
        cloudInstalledForMerge ??
        (cloudMarketplaceAvailable && hasCachedSnapshot
          ? previousInstalledRaw.filter(plugin => typeof plugin.spec.pluginId === 'number')
          : [])
      const nextInstalledRaw = mergeInstalledPlugins(
        cloudInstalled,
        localInstalledForMerge,
        localStateForMerge?.deviceId || deviceIdHint || currentDeviceIdRef.current || ''
      ).map(toInstalledPluginItem)
      // Prefer in-flight cloud rows, then this key's durable cache — never stale
      // previous-account React state after a cache miss / account switch.
      const cloudItems = preferNonEmptyCatalogRows(
        cloudItemsForMerge,
        preferNonEmptyCatalogRows(cachedCloudItems, nonCodexCatalogItems(previousItems))
      )
      const retained = retainMarketplaceInstalledState({
        previousItems: pluginMarketplaceStateRef.current.items,
        nextItems: mergeMarketplaceCatalog(
          cloudItems,
          localRows,
          nextInstalledRaw.map(plugin => plugin.raw)
        ),
        previousInstalled: installedPluginsRef.current,
        nextInstalled: nextInstalledRaw,
        previousStateMatchesScope: marketplaceStateCacheKeyRef.current === marketplaceCacheKeyValue,
      })
      const heldBack = holdBackInFlightMarketplaceInstalls({
        items: retained.items,
        installed: retained.installed,
        installingIds: installingMarketplacePluginIdsRef.current,
        authPluginKey: pendingLocalConnectorAuthRef.current?.target.pluginKey,
      })
      const nextInstalled = heldBack.installed
      const mergedItems = heldBack.items
      // Publish installed rows even when the catalog is still empty — cloud
      // listInstalledPlugins often arrives before marketplace rows.
      if (localStateForMerge || cloudInstalledForMerge) {
        setInstalledPlugins(previous =>
          sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
        )
      }
      // An incomplete Codex plugin/list after resume can merge to zero rows.
      // Never persist that over a warm catalog — it made every background return
      // look like a first marketplace sync.
      if (mergedItems.length === 0) {
        if (localStateForMerge || cloudInstalledForMerge) {
          setIsMarketplaceRefreshing(options.keepRefreshing)
        }
        return
      }

      // Keep the live catalog in memory so later merges see device pending.
      // Persist stays debounced unless this is an explicit refresh.
      const progressiveMarketplaces =
        localStateForMerge != null
          ? toMarketplaceOptions(
              localStateForMerge.marketplaces,
              cloudMarketplaceAvailable,
              t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
            )
          : marketplacesRef.current
      setPluginMarketplaceCache({
        cacheKey: marketplaceCacheKeyValue,
        marketplaceItems: mergedItems,
        installedPlugins: nextInstalled,
        marketplaces: progressiveMarketplaces,
        selectedMarketplaceKey: selectedMarketplaceKeyRef.current,
        deviceId: localStateForMerge?.deviceId || deviceIdHint || currentDeviceIdRef.current || '',
        fetchedAt: Date.now(),
      })
      setPluginMarketplaceState(previous => {
        if (sameMarketplaceItems(previous.items, mergedItems) && !previous.error) {
          return { ...previous, isLoading: false, error: null }
        }
        return { items: mergedItems, isLoading: false, error: null }
      })
      setMarketplaceLoadingMessage('')
      setIsMarketplaceRefreshing(options.keepRefreshing)
    }

    // Always paint durable/local peek early — even when a same-session memory cache
    // already has cloud rows — so OpenAI官方 is not empty until plugin/list returns.
    if (peekedLocalState) {
      paintPartialCatalog({
        localState: peekedLocalState,
        // Peek already paints OpenAI/local rows. Only keep the top-bar spinner for an
        // explicit refresh — background revalidation must stay silent.
        keepRefreshing: isExplicitRefresh,
      })
    }

    const personalDiskPromise = listPersonalMarketplacePluginsFromDisk().catch(error => {
      console.warn('[Wework] personal marketplace disk paint failed', error)
      return [] as PluginMarketplaceItem[]
    })
    void personalDiskPromise
      .then(diskPersonalItems => {
        if (!isCurrent) return
        if (diskPersonalItems.length === 0) return
        diskPersonalItemsForMerge = diskPersonalItems
        if (catalogSettled) {
          // Final snapshot may have landed before disk I/O; merge personal rows now.
          const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
          const cloudItems =
            cloudItemsForMerge ??
            (cached?.marketplaceItems ?? []).filter(item => !isCodexCatalogItem(item))
          const localRows = mergeDiskPersonalIntoLocalRows(
            localStateForMerge?.marketplaceItems ??
              (cached?.marketplaceItems ?? []).filter(isCodexCatalogItem),
            diskPersonalItems
          )
          const cachedInstalledRaw = (cached?.installedPlugins ?? []).map(plugin => plugin.raw)
          const localInstalledForMerge = resolveProgressiveLocalInstalledRaw({
            hasCachedSnapshot: cached != null,
            cachedInstalledRaw,
            localInstalledRaw: localStateForMerge?.installedPlugins,
            localStateIsPeek:
              peekedLocalState != null &&
              localStateForMerge != null &&
              localStateForMerge === peekedLocalState,
            cachedDeviceId: cached?.deviceId,
            localDeviceId: localStateForMerge?.deviceId,
          })
          const nextInstalledRaw = mergeInstalledPlugins(
            cloudInstalledForMerge ??
              (cloudMarketplaceAvailable && cached != null
                ? cachedInstalledRaw.filter(plugin => typeof plugin.spec.pluginId === 'number')
                : []),
            localInstalledForMerge,
            localStateForMerge?.deviceId || deviceIdHint || currentDeviceIdRef.current || ''
          ).map(toInstalledPluginItem)
          const retained = retainMarketplaceInstalledState({
            previousItems: pluginMarketplaceStateRef.current.items,
            nextItems: mergeMarketplaceCatalog(
              cloudItems,
              localRows,
              nextInstalledRaw.map(plugin => plugin.raw)
            ),
            previousInstalled: installedPluginsRef.current,
            nextInstalled: nextInstalledRaw,
            previousStateMatchesScope:
              marketplaceStateCacheKeyRef.current === marketplaceCacheKeyValue,
          })
          const heldBack = holdBackInFlightMarketplaceInstalls({
            items: retained.items,
            installed: retained.installed,
            installingIds: installingMarketplacePluginIdsRef.current,
            authPluginKey: pendingLocalConnectorAuthRef.current?.target.pluginKey,
          })
          const nextInstalled = heldBack.installed
          const mergedItems = heldBack.items
          setInstalledPlugins(previous =>
            sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
          )
          setPluginMarketplaceState(previous =>
            sameMarketplaceItems(previous.items, mergedItems)
              ? previous
              : { items: mergedItems, isLoading: false, error: null }
          )
          return
        }
        // Always paint disk personal rows, even when a cloud cache already filled the
        // catalog. Skipping here left "个人创建" waiting on Codex plugin/list (~10s).
        paintPartialCatalog({
          diskPersonalItems,
          localState: localStateForMerge,
          keepRefreshing: isExplicitRefresh,
        })
      })
      .finally(() => {
        if (!isCurrent) return
        setPersonalDiskSettledKey(marketplaceCacheKeyValue)
      })

    void localPromise
      .then(localState => {
        if (!localState) return
        localStateForMerge = localState
        // Peek path already painted above; avoid a redundant same-snapshot paint.
        if (peekedLocalState && localState === peekedLocalState) {
          return
        }
        paintPartialCatalog({
          localState,
          diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
          keepRefreshing: isExplicitRefresh,
        })
      })
      .catch(() => undefined)
      .finally(() => {
        // Live plugin/list is deferred. Only clear official loading when peek already
        // has that catalog; otherwise the official tab would flash empty.
        if (isCurrent && hasWarmOpenAiCatalog) setIsOpenAiOfficialCatalogLoading(false)
      })

    // Paint the installed strip as soon as account installs arrive — do not wait on
    // marketplace catalog or Codex plugin/list. That is what made Wework/official
    // icons flash in after OpenAI/local peeks.
    void installedPromise.then(installed => {
      if (!isCurrent || catalogSettled) return
      paintPartialCatalog({
        cloudInstalled: installed.items,
        localState: localStateForMerge,
        diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
        keepRefreshing: isExplicitRefresh,
      })
    })

    // Membership is a dedicated plugin/installed call. Never wait on plugin/list
    // (OpenAI GitHub reconcile) before auto-sync or device-gap overlay.
    void membershipPromise
      .then(membership => {
        if (!isCurrent) return
        liveLocalInstalledForMerge = membership.items
        if (membership.deviceId) {
          setCurrentDeviceId(membership.deviceId)
        }
        paintPartialCatalog({
          liveLocalInstalled: membership.items,
          localState: localStateForMerge,
          cloudItems: cloudItemsForMerge ?? undefined,
          cloudInstalled: cloudInstalledForMerge ?? undefined,
          diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
          keepRefreshing: isExplicitRefresh && !catalogSettled,
          ignoreSettled: true,
        })
      })
      .catch(() => undefined)

    void Promise.allSettled([cloudPromise, installedPromise]).then(
      ([cloudResult, installedResult]) => {
        if (!isCurrent || catalogSettled) return
        const cloudItems = cloudResult.status === 'fulfilled' ? cloudResult.value.items : []
        const cloudInstalled =
          installedResult.status === 'fulfilled' ? installedResult.value.items : []
        if (cloudResult.status === 'rejected' && cloudItems.length === 0) return

        paintPartialCatalog({
          cloudItems,
          cloudInstalled,
          localState: localStateForMerge,
          diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
          keepRefreshing: isExplicitRefresh,
        })
      }
    )

    void Promise.allSettled([
      localPromise,
      cloudPromise,
      installedPromise,
      personalDiskPromise,
      membershipPromise,
    ]).then(([localResult, cloudResult, installedResult, diskResult, membershipResult]) => {
      if (!isCurrent) return
      catalogSettled = true
      setMarketplaceLoadingMessage('')
      setIsMarketplaceRefreshing(false)

      if (diskResult.status === 'fulfilled' && diskResult.value.length > 0) {
        diskPersonalItemsForMerge = diskResult.value
      }

      if (localResult.status === 'rejected' && cloudResult.status === 'rejected') {
        const error = localResult.reason instanceof Error ? localResult.reason : cloudResult.reason
        if (!hasCachedCatalog) {
          setPluginMarketplaceState({
            items: [],
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to load plugin marketplace',
          })
        }
        return
      }

      // Prefer a background-refreshed local snapshot over the settle promise value.
      // Stale-peek SWR resolves localPromise immediately with the peek; a concurrent
      // refresh:true may already have written a newer localStateForMerge.
      const localState =
        localStateForMerge ?? (localResult.status === 'fulfilled' ? localResult.value : null)
      const cloudItems = cloudResult.status === 'fulfilled' ? cloudResult.value.items : []
      const cloudInstalled =
        installedResult.status === 'fulfilled' ? installedResult.value.items : []
      const membershipDeviceId =
        membershipResult.status === 'fulfilled' ? membershipResult.value.deviceId || '' : ''

      if (localState) {
        setCurrentDeviceId(localState.deviceId)
        applyLocalMarketplaceState(localState)
        const selectedKey = localState.selectedMarketplaceId
          ? localMarketplaceKey(localState.selectedMarketplaceId)
          : ''
        initialMarketplaceLoadKeyRef.current = selectedKey
      } else if (membershipDeviceId) {
        setCurrentDeviceId(membershipDeviceId)
      }

      const resolvedDeviceId =
        localState?.deviceId ||
        membershipDeviceId ||
        currentDeviceIdRef.current ||
        deviceIdHint ||
        ''
      const initialCloudDeviceId = deviceIdHint || peekedLocalState?.deviceId || ''
      const needsDeviceScopedCloudPass =
        cloudMarketplaceAvailable &&
        Boolean(resolvedDeviceId) &&
        resolvedDeviceId !== initialCloudDeviceId
      // Unscoped marketplace lists report account installs as installed:true with
      // no device row. Opening GitHub plugin/list from that snapshot blocks
      // wegent ZIP/install on the shared Codex lock.
      applyCatalogSnapshot(cloudItems, cloudInstalled, localState, {
        // When durable storage had to drop data-URL logos, always take the network
        // catalog so official plugins do not stay stuck on name initials.
        preferExistingOnSameSignature: !isExplicitRefresh && !cached?.logosStripped,
        keepLoadingWhenEmpty: !peekedLocalState && !localState,
        deferInventoryReady: needsDeviceScopedCloudPass,
      })

      if (needsDeviceScopedCloudPass) {
        void Promise.all([
          pluginApi
            .listMarketplacePlugins({
              deviceId: resolvedDeviceId,
            })
            .catch(() => ({ items: [] as PluginMarketplaceItem[] })),
          pluginApi
            .listInstalledPlugins(resolvedDeviceId)
            .catch(() => ({ items: [] as InstalledPlugin[] })),
        ])
          .then(([deviceCloud, deviceInstalled]) => {
            if (!isCurrent) return
            // Prefer a background-refreshed local snapshot over the settle-time
            // peek — otherwise device cloud arrival can clobber DISABLED_BY_ADMIN
            // rows that refresh already painted.
            applyCatalogSnapshot(
              deviceCloud.items,
              deviceInstalled.items,
              localStateForMerge ?? localState,
              {
                preferExistingOnSameSignature: true,
              }
            )
          })
          .catch(() => {
            if (isCurrent) markAutoSyncInventoryReady()
          })
      }
    })

    return () => {
      isCurrent = false
    }
  }, [
    applyLocalMarketplaceState,
    cloudMarketplaceAvailable,
    localPluginApi,
    marketplaceCacheKeyValue,
    marketplaceRefreshTick,
    pluginApi,
    t,
  ])

  useEffect(() => {
    if (!cloudMarketplaceAvailable || !cloudToken || !currentDeviceId) return
    if (!deviceCloudConnected) return
    if (localInstalledStateReadyKey !== marketplaceCacheKeyValue) return
    if (pluginMarketplaceState.isLoading) return
    const autoUpdateCandidateReleaseKeys = pluginMarketplaceState.items.flatMap(item => {
      if (!marketplaceItemNeedsPluginAutoUpdate(item)) return []
      if (item.installedPluginId === null || item.installedPluginId === undefined) return []
      const installed = installedPlugins.find(
        plugin => String(plugin.id) === String(item.installedPluginId)
      )
      if (
        !installed ||
        !isCloudManagedInstalledPlugin(installed.raw) ||
        installed.raw.spec.updatePolicy !== 'auto'
      ) {
        return []
      }
      const targetReleaseId =
        item.latestReleaseId ?? item.currentDeviceInstallation?.desiredReleaseId
      return targetReleaseId === null || targetReleaseId === undefined
        ? []
        : [`${item.installedPluginId}:${targetReleaseId}`]
    })
    if (autoUpdateCandidateReleaseKeys.length === 0) return
    const releaseKey = autoUpdateCandidateReleaseKeys.sort().join(',')
    const attemptKey = `${marketplaceCacheKeyValue}:${currentDeviceId}:${releaseKey}`
    if (autoUpdateAttemptKeysRef.current.has(attemptKey)) return

    const finishDeviceSync = beginPluginDeviceSync(currentDeviceId)
    if (!finishDeviceSync) return
    setDeviceAutoSyncSettled(false)
    autoUpdateAttemptKeysRef.current.add(attemptKey)
    const deviceId = currentDeviceId

    void runPluginAutoUpdate({
      updateBatch: () => pluginApi.autoUpdateInstalledPlugins(),
      syncDevice: () => pluginApi.syncInstalledPluginsToDevice(deviceId),
      syncWhenNoUpdates: marketplaceNeedsDeviceSync(pluginMarketplaceState.items),
      onProgress: ({ updatedCount, remainingCount }) => {
        if (currentDeviceIdRef.current !== deviceId) return
        setPluginOperationNotice({
          id: `plugin-auto-update-${deviceId}`,
          kind: 'authorization',
          message: t(
            'workbench.plugins_auto_update_progress',
            '正在自动更新插件：已处理 {{updated}} 个，剩余 {{remaining}} 个',
            { updated: updatedCount, remaining: remainingCount }
          ),
        })
      },
    })
      .then(updatedCount => {
        if (currentDeviceIdRef.current !== deviceId) return
        if (updatedCount > 0) {
          setPluginOperationNotice({
            id: `plugin-auto-update-complete-${deviceId}`,
            kind: 'success',
            message: t('workbench.plugins_auto_update_complete', '已自动更新 {{count}} 个插件', {
              count: updatedCount,
            }),
          })
        } else {
          setPluginOperationNotice(current =>
            current?.id === `plugin-auto-update-${deviceId}` ? null : current
          )
        }
        markPluginDeviceAutoSyncAttempted(deviceId)
        markPluginDeviceAutoSyncSettled(deviceId)
        setDeviceAutoSyncSettled(true)
      })
      .catch(error => {
        if (currentDeviceIdRef.current !== deviceId) return
        markPluginDeviceAutoSyncAttempted(deviceId)
        markPluginDeviceAutoSyncSettled(deviceId)
        setDeviceAutoSyncSettled(true)
        setPluginOperationNotice({
          id: `plugin-auto-update-error-${deviceId}`,
          kind: 'error',
          message: t(
            'workbench.plugins_auto_update_failed',
            '插件自动更新失败，当前设备继续使用原版本：{{error}}',
            { error: getErrorMessage(error, 'Unknown error') }
          ),
        })
        track('operation_failed', { operation: 'plugin_auto_update' })
      })
      .finally(() => {
        finishDeviceSync()
        if (currentDeviceIdRef.current === deviceId) {
          setMarketplaceRefreshTick(previous => previous + 1)
        }
      })
  }, [
    cloudMarketplaceAvailable,
    cloudToken,
    currentDeviceId,
    deviceCloudConnected,
    installedPlugins,
    localInstalledStateReadyKey,
    marketplaceCacheKeyValue,
    pluginApi,
    pluginMarketplaceState.isLoading,
    pluginMarketplaceState.items,
    t,
  ])

  useEffect(() => {
    if (!cloudMarketplaceAvailable || !cloudToken || !currentDeviceId) return
    if (localInstalledStateReadyKey !== marketplaceCacheKeyValue) return
    if (pluginMarketplaceState.isLoading) return
    const deviceId = currentDeviceId
    const reports = collectPluginDeviceStatusReports(
      installedPlugins.map(plugin => plugin.raw),
      pluginMarketplaceState.items,
      deviceId
    )
    const reportIds = reports.map(report => report.installedPluginId)
    const needsPackageSync = marketplaceNeedsDeviceSync(pluginMarketplaceState.items)
    if (reportIds.length === 0 && !needsPackageSync) {
      if (
        hasAttemptedPluginDeviceStatusReport(deviceId) &&
        !hasSettledPluginDeviceAutoSync(deviceId)
      ) {
        markPluginDeviceAutoSyncSettled(deviceId)
        setDeviceAutoSyncSettled(true)
      }
      return
    }

    const refreshCatalog = async () => {
      if (currentDeviceIdRef.current !== deviceId) return
      const [cloud, installed] = await Promise.all([
        pluginApi.listMarketplacePlugins({
          deviceId,
        }),
        pluginApi.listInstalledPlugins(deviceId).catch(() => ({ items: [] as InstalledPlugin[] })),
      ])
      if (currentDeviceIdRef.current !== deviceId) return
      const nextInstalled = mergeInstalledPlugins(
        installed.items,
        installedPluginsRef.current.map(plugin => plugin.raw),
        deviceId
      ).map(toInstalledPluginItem)
      setInstalledPlugins(previous =>
        sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
      )
      setPluginMarketplaceState(previous => {
        const nextItems = mergeMarketplaceCatalog(
          cloud.items,
          previous.items.filter(isCodexCatalogItem),
          nextInstalled.map(plugin => plugin.raw)
        )
        if (sameMarketplaceItems(previous.items, nextItems) && !previous.error) {
          return previous
        }
        const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
        if (cached) {
          setPluginMarketplaceCache({
            ...cached,
            marketplaceItems: nextItems,
            installedPlugins: nextInstalled,
            deviceId,
            fetchedAt: Date.now(),
          })
        }
        return { ...previous, items: nextItems, error: null }
      })
    }

    if (reports.length > 0 && !hasAttemptedPluginDeviceStatusReport(deviceId, reports)) {
      const finishDeviceSync = beginPluginDeviceSync(deviceId)
      if (!finishDeviceSync) return
      void pluginApi
        .reportInstalledPluginsOnDevice(deviceId, reports)
        .then(response => {
          if (currentDeviceIdRef.current !== deviceId) return
          markPluginDeviceStatusReportAttempted(deviceId, reports)
          deviceStatusReportFailureCountsRef.current.delete(deviceId)
          if (deviceStatusReportRetryTimerRef.current !== null) {
            window.clearTimeout(deviceStatusReportRetryTimerRef.current)
            deviceStatusReportRetryTimerRef.current = null
          }
          const acknowledgedIds = response.acknowledgedInstalledPluginIds
          if (acknowledgedIds.length > 0) {
            setInstalledPlugins(previous => {
              const next = withAcknowledgedDeviceInstallations(
                previous.map(plugin => plugin.raw),
                deviceId,
                acknowledgedIds
              ).map(toInstalledPluginItem)
              return sameInstalledPlugins(previous, next) ? previous : next
            })
            setPluginMarketplaceState(previous => ({
              ...previous,
              items: withAcknowledgedMarketplaceDeviceState(
                previous.items,
                deviceId,
                acknowledgedIds
              ),
            }))
          }
          return refreshCatalog().catch(() => undefined)
        })
        .catch(() => {
          if (currentDeviceIdRef.current !== deviceId) return
          const failureCount = (deviceStatusReportFailureCountsRef.current.get(deviceId) ?? 0) + 1
          deviceStatusReportFailureCountsRef.current.set(deviceId, failureCount)
          if (
            failureCount <= DEVICE_STATUS_REPORT_MAX_RETRIES &&
            deviceStatusReportRetryTimerRef.current === null
          ) {
            const delay = DEVICE_STATUS_REPORT_RETRY_BASE_MS * 2 ** (failureCount - 1)
            deviceStatusReportRetryTimerRef.current = window.setTimeout(() => {
              deviceStatusReportRetryTimerRef.current = null
              if (currentDeviceIdRef.current === deviceId) {
                setMarketplaceRefreshTick(previous => previous + 1)
              }
            }, delay)
          }
        })
        .finally(finishDeviceSync)
      return
    }

    if (!needsPackageSync) return
    if (!deviceCloudConnected) {
      setDeviceAutoSyncSettled(true)
      return
    }
    if (hasAttemptedPluginDeviceAutoSync(currentDeviceId)) return

    const finishDeviceSync = beginPluginDeviceSync(currentDeviceId)
    if (!finishDeviceSync) return

    setDeviceAutoSyncSettled(false)
    markPluginDeviceAutoSyncAttempted(currentDeviceId)

    // Only paint "同步中" after live membership confirmed a real device gap.
    setPluginMarketplaceState(previous => ({
      ...previous,
      items: withOptimisticDevicePending(previous.items, deviceId),
    }))

    // Do not cancel on items/deps churn (optimistic pending updates re-enter this
    // effect). Only ignore the result if the active device changed.
    void pluginApi
      .syncInstalledPluginsToDevice(deviceId)
      .catch(() => undefined)
      .then(refreshCatalog)
      .then(() => {
        if (currentDeviceIdRef.current === deviceId) {
          markPluginDeviceAutoSyncSettled(deviceId)
          setDeviceAutoSyncSettled(true)
        }
      })
      .catch(() => {
        if (currentDeviceIdRef.current === deviceId) {
          markPluginDeviceAutoSyncSettled(deviceId)
          setDeviceAutoSyncSettled(true)
        }
      })
      .finally(finishDeviceSync)
  }, [
    cloudMarketplaceAvailable,
    cloudToken,
    currentDeviceId,
    deviceCloudConnected,
    installedPlugins,
    localInstalledStateReadyKey,
    marketplaceCacheKeyValue,
    pluginApi,
    pluginMarketplaceState.isLoading,
    pluginMarketplaceState.items,
  ])

  const pendingDevicePackageSync =
    cloudMarketplaceAvailable &&
    Boolean(cloudToken) &&
    Boolean(currentDeviceId) &&
    deviceCloudConnected &&
    marketplaceNeedsDeviceSync(pluginMarketplaceState.items) &&
    !deviceAutoSyncSettled

  // GitHub plugin/list shares the Codex app-server lock with wegent
  // plugin/install. Order: Wework official + enterprise (cloud catalog and
  // device ZIP/install) and personal-created (disk listing), then GitHub.
  useEffect(() => {
    if (localInstalledStateReadyKey !== marketplaceCacheKeyValue) return
    if (personalDiskSettledKey !== marketplaceCacheKeyValue) return
    if (pendingDevicePackageSync) return

    const shouldReconcileGithubCatalog = reconcileGithubCatalogRef.current
    const skipGithubCatalogReconcile = skipGithubCatalogReconcileRef.current
    skipGithubCatalogReconcileRef.current = false
    // Warm OpenAI rows already come from peek/cache. Auto plugin/list reconciles
    // github.com/openai/plugins and holds the shared Codex lock, which stalls chat
    // send. Only refresh after the user explicitly asks.
    if (
      skipGithubCatalogReconcile ||
      (!shouldReconcileGithubCatalog &&
        hasOpenAiOfficialCatalog(pluginMarketplaceStateRef.current.items))
    ) {
      setIsOpenAiOfficialCatalogLoading(false)
      return
    }

    const requestKey = `${marketplaceCacheKeyValue}:${marketplaceRefreshTick}`
    if (deferredCodexCatalogRequestRef.current === requestKey) return
    reconcileGithubCatalogRef.current = false

    deferredCodexCatalogRequestRef.current = requestKey
    let cancelled = false
    void localPluginApi
      .readState({
        mergeAllMarketplaces: true,
        refresh: true,
      })
      .then(localState => {
        if (cancelled) return
        if (deferredCodexCatalogRequestRef.current !== requestKey) return
        applyLiveCodexCatalog(localState)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      if (deferredCodexCatalogRequestRef.current === requestKey) {
        deferredCodexCatalogRequestRef.current = ''
      }
    }
  }, [
    applyLiveCodexCatalog,
    localInstalledStateReadyKey,
    localPluginApi,
    marketplaceCacheKeyValue,
    marketplaceRefreshTick,
    pendingDevicePackageSync,
    personalDiskSettledKey,
  ])

  useEffect(() => {
    if (!cloudMarketplaceAvailable) return

    let disposed = false
    const revalidateCloudMarketplace = () => {
      void pluginApi
        .listMarketplacePlugins({
          deviceId: currentDeviceId || undefined,
        })
        .then(response => {
          if (disposed) return
          setPluginMarketplaceState(previous => {
            const nextItems = mergeMarketplaceCatalog(
              response.items,
              previous.items.filter(isCodexCatalogItem),
              installedPluginsRef.current.map(plugin => plugin.raw)
            )
            if (sameMarketplaceItems(previous.items, nextItems)) {
              return previous
            }
            const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
            if (cached) {
              setPluginMarketplaceCache({
                ...cached,
                marketplaceItems: nextItems,
                fetchedAt: Date.now(),
              })
            }
            return { ...previous, items: nextItems, error: null }
          })
        })
        .catch(() => undefined)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        revalidateCloudMarketplace()
      }
    }

    window.addEventListener('focus', revalidateCloudMarketplace)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    const intervalId = window.setInterval(
      revalidateCloudMarketplace,
      CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS
    )

    return () => {
      disposed = true
      window.removeEventListener('focus', revalidateCloudMarketplace)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearInterval(intervalId)
    }
  }, [cloudMarketplaceAvailable, currentDeviceId, marketplaceCacheKeyValue, pluginApi])

  const { selectedPlugin, selectedMarketplacePlugin, dismissPluginReferenceDetail } =
    usePluginDetailSelection({
      pluginReference,
      pluginMarketplaceState,
      installedPlugins,
      selectedPluginId,
      selectedMarketplacePluginId,
      setSelectedPluginId,
      setSelectedMarketplacePluginId,
    })

  useEffect(() => {
    void refreshPublicationRequests().catch(() => undefined)
  }, [refreshPublicationRequests])

  const openPublicationProgress = async (requestId: number, revisionNumber?: number) => {
    const cached = publicationRequests.find(publication => publication.id === requestId)
    if (cached && revisionNumber === undefined) setPublicationProgress(cached)
    setPublicationProgressLoading(true)
    try {
      const publication = await pluginApi.getPublicationRequest(requestId, revisionNumber)
      setPublicationProgress(publication)
      if (
        revisionNumber === undefined ||
        publication.revision.number === publication.currentRevision
      ) {
        setPublicationRequests(previous => mergePublicationRequests(previous, [publication]))
      }
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to load publication request',
      }))
    } finally {
      setPublicationProgressLoading(false)
    }
  }

  const withdrawPublication = async (publication: PluginPublicationRequestItem) => {
    setWithdrawingPublicationId(publication.id)
    try {
      const updated = await pluginApi.withdrawPublicationRequest(
        publication.id,
        publication.currentRevision
      )
      setPublicationRequests(previous => mergePublicationRequests(previous, [updated]))
      setPublicationProgress(current => (current?.id === updated.id ? updated : current))
      setPluginOperationNotice({
        id: 'publication-withdrawn-' + updated.id,
        kind: 'success',
        message: t('workbench.plugins_publication_withdrawn_notice', '全员发布申请已撤回。'),
      })
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to withdraw publication request',
      }))
    } finally {
      setWithdrawingPublicationId(null)
    }
  }

  const closePluginDetail = (clearLocalSelection: () => void) => {
    if (pluginReference?.pluginName && pluginReference.marketplaceName) {
      dismissPluginReferenceDetail()
      window.history.back()
      return
    }
    clearLocalSelection()
  }

  useEffect(() => {
    const detailPlugin = selectedPlugin
      ? selectedPlugin
      : selectedMarketplacePlugin
        ? (() => {
            const installedDetail =
              selectedMarketplacePlugin.installedPluginId === null ||
              selectedMarketplacePlugin.installedPluginId === undefined
                ? null
                : (installedPlugins.find(
                    plugin =>
                      String(plugin.id) === String(selectedMarketplacePlugin.installedPluginId)
                  ) ?? null)
            return installedDetail
          })()
        : null

    const connectors = detailPlugin?.raw.spec.components.connectors ?? []
    const localConnectors = connectors.filter(connector => isLocalConnector(connector))
    if (!detailPlugin || localConnectors.length === 0) {
      setLocalConnectorAuthBySlug({})
      return
    }

    let cancelled = false
    const pluginKey = detailPlugin.raw.spec.source.pluginKey
    void Promise.all(
      localConnectors.map(async connector => {
        try {
          const health = await localConnectorAuthHealth({
            pluginKey,
            connectorSlug: connector.slug,
            localAuth: connector.localAuth ?? null,
          })
          return [
            connector.slug,
            localQrManageActionFromHealth(health) === 'logout' ? 'connected' : 'disconnected',
          ] as const
        } catch {
          return [connector.slug, 'disconnected'] as const
        }
      })
    ).then(entries => {
      if (cancelled) return
      setLocalConnectorAuthBySlug(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [installedPlugins, selectedMarketplacePlugin, selectedPlugin])

  const selectedMarketplacePluginRef = useRef(selectedMarketplacePlugin)
  selectedMarketplacePluginRef.current = selectedMarketplacePlugin
  const installedPluginsForDetailRef = useRef(installedPlugins)
  installedPluginsForDetailRef.current = installedPlugins
  const selectedMarketplaceDetailKey = selectedMarketplacePlugin
    ? `${localMarketplaceIdFromItem(selectedMarketplacePlugin) ?? ''}::${selectedMarketplacePlugin.name}`
    : ''

  useEffect(() => {
    if (!selectedMarketplaceDetailKey) {
      setSelectedMarketplacePluginDetail(null)
      return
    }

    const selected = selectedMarketplacePluginRef.current
    if (!selected) {
      setSelectedMarketplacePluginDetail(null)
      return
    }

    const installedDetail = findInstalledPluginForMarketplaceItem(
      selected,
      installedPluginsForDetailRef.current
    )
    const baseDetail = installedDetail
      ? withMarketplaceListingInterface(installedDetail, selected)
      : toMarketplaceInstalledPluginItem(selected)

    const marketplaceId = localMarketplaceIdFromItem(selected)
    const shouldFetchLocalDetail = Boolean(marketplaceId)

    if (!shouldFetchLocalDetail) {
      setSelectedMarketplacePluginDetail(previous =>
        keepRicherMarketplacePluginDetail(previous, baseDetail)
      )
      return
    }

    let disposed = false
    setSelectedMarketplacePluginDetail(previous =>
      keepRicherMarketplacePluginDetail(previous, baseDetail)
    )
    void localPluginApi
      .readMarketplacePluginDetail(marketplaceId!, selected.name)
      .then(detail => {
        if (disposed) return
        setSelectedMarketplacePluginDetail(previous =>
          withMarketplacePluginDetail(
            keepRicherMarketplacePluginDetail(previous, baseDetail),
            detail
          )
        )
      })
      .catch(() => undefined)

    return () => {
      disposed = true
    }
  }, [localPluginApi, selectedMarketplaceDetailKey])

  useEffect(() => {
    if (!selectedMarketplacePlugin) {
      setSelectedRequiredConnectionNames(null)
      return
    }

    const detailedItem = withMarketplaceDetailComponents(
      selectedMarketplacePlugin,
      selectedMarketplacePluginDetail
    )
    let disposed = false
    setSelectedRequiredConnectionNames(null)
    void connectionNamesRequiredForInstall(detailedItem).then(names => {
      if (!disposed) setSelectedRequiredConnectionNames(names)
    })
    return () => {
      disposed = true
    }
  }, [
    connectionNamesRequiredForInstall,
    selectedMarketplacePlugin,
    selectedMarketplacePluginDetail,
  ])

  useEffect(() => {
    marketplaceReturnScrollTopRef.current = null
    if (marketplaceScrollRegionRef.current) {
      marketplaceScrollRegionRef.current.scrollTop = 0
    }
  }, [marketplaceDistributionFilter, marketplaceSourceFilterKey, normalizedQuery])

  useEffect(() => {
    if (selectedMarketplacePluginId !== null) return
    const returnScrollTop = marketplaceReturnScrollTopRef.current
    if (returnScrollTop === null) return
    const frameId = window.requestAnimationFrame(() => {
      if (marketplaceScrollRegionRef.current) {
        marketplaceScrollRegionRef.current.scrollTop = returnScrollTop
        marketplaceReturnScrollTopRef.current = null
      }
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [selectedMarketplacePluginId])

  useEffect(() => {
    if (pluginOperationNotice?.kind !== 'success' || pluginOperationNotice.actionLabel) return
    const noticeId = pluginOperationNotice.id
    const timeoutId = window.setTimeout(() => {
      setPluginOperationNotice(current => (current?.id === noticeId ? null : current))
    }, 4_000)
    return () => window.clearTimeout(timeoutId)
  }, [pluginOperationNotice])

  const pluginShareDialog = pluginShareState ? (
    <PluginShareDialog
      pluginName={pluginShareState.plugin.displayName || pluginShareState.plugin.name}
      access={pluginShareState.access}
      saving={pluginShareSaving}
      error={pluginShareError}
      onClose={() => setPluginShareState(null)}
      onSave={request => void savePluginShare(request)}
      searchUsers={searchPluginShareUsers}
      searchGroups={searchPluginShareGroups}
    />
  ) : null

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
  const pluginPublishDialog = pluginPublishTarget ? (
    <PluginPublishDialog
      pluginName={pluginPublishTarget.name}
      pluginVersion={pluginPublishTarget.version || '0.1.0'}
      publishing={isUploadingPlugin}
      error={pluginPublishError}
      initialAccess={pluginPublishAccess}
      activePublication={
        pluginPublishPublication
          ? {
              id: pluginPublishPublication.id,
              version: pluginPublishPublication.requestedVersion,
              status: pluginPublishPublication.status,
              canCreateRevision: pluginPublishPublication.actionEligibility.canCreateRevision,
            }
          : null
      }
      onViewPublication={requestId => {
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        void openPublicationProgress(requestId)
      }}
      shareRecoveryLabel={
        pluginPublishShareRecovery
          ? t('workbench.plugins_version_exists_go_share', '去分享成员')
          : null
      }
      onShareRecovery={pluginPublishShareRecovery ? recoverPublishToShare : undefined}
      onClose={() => {
        if (isUploadingPlugin) return
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        setPluginPublishError(null)
        setPluginPublishShareRecovery(false)
      }}
      onPublish={request => void publishCreatedPlugin(pluginPublishTarget, request)}
      searchUsers={searchPluginShareUsers}
      searchGroups={searchPluginShareGroups}
    />
  ) : null
  const openPublicationRevision = (publication: PluginPublicationRequestItem) => {
    const target = findPackableCreatedPlugin(installedPlugins, [
      publication.pluginSlug,
      publication.pluginName,
    ])
    if (!target) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t(
          'workbench.plugins_publish_source_missing',
          '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
        ),
      }))
      return
    }
    setPublicationProgress(null)
    openPublishCreatedPlugin(target)
  }
  const openPublishedEnterprisePlugin = async (publication: PluginPublicationRequestItem) => {
    if (!publication.enterprisePluginId) {
      await openPublicationProgress(publication.id)
      return
    }
    let enterpriseItem = pluginMarketplaceStateRef.current.items.find(
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
          setPluginMarketplaceState(previous => ({
            ...previous,
            items: [
              nextEnterpriseItem,
              ...previous.items.filter(item => item.id !== nextEnterpriseItem.id),
            ],
          }))
        }
      }
      if (!enterpriseItem) throw new Error('Enterprise plugin is not available in the catalog')
      setPublicationProgress(null)
      setSelectedPluginId(null)
      setSelectedMarketplacePluginId(enterpriseItem.id)
    } catch {
      setPluginOperationNotice({
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
  const publicationProgressDrawer = publicationProgress ? (
    <PluginPublicationProgressDrawer
      publication={publicationProgress}
      requestHistory={publicationProgressHistory}
      loading={publicationProgressLoading}
      withdrawing={withdrawingPublicationId === publicationProgress.id}
      onClose={() => setPublicationProgress(null)}
      onRefresh={() =>
        void openPublicationProgress(publicationProgress.id, publicationProgress.revision.number)
      }
      onSelectRequest={requestId => void openPublicationProgress(requestId)}
      onSelectRevision={revisionNumber =>
        void openPublicationProgress(publicationProgress.id, revisionNumber)
      }
      onWithdraw={
        publicationProgress.actionEligibility.canWithdraw
          ? () => void withdrawPublication(publicationProgress)
          : undefined
      }
      onCreateRevision={
        publicationProgress.actionEligibility.canCreateRevision
          ? () => openPublicationRevision(publicationProgress)
          : undefined
      }
      onViewEnterprise={
        publicationProgress.actionEligibility.canViewEnterprisePlugin
          ? () => void openPublishedEnterprisePlugin(publicationProgress)
          : undefined
      }
    />
  ) : null

  const pluginOperationNoticeOverlay = pluginOperationNotice ? (
    <PluginOperationNotice
      notice={pluginOperationNotice}
      onDismiss={() => setPluginOperationNotice(null)}
    />
  ) : null

  const pendingInstallLogo = pendingInstall
    ? resolvePluginLogo({
        pluginKey: pendingInstall.item.name,
        logo: pendingInstall.item.interface?.logo,
        logoDark: pendingInstall.item.interface?.logoDark,
        composerIcon: pendingInstall.item.interface?.composerIcon,
        appearanceMode,
      })
    : null

  const pluginOverlayDialogs = (
    <>
      {pendingInstall && (
        <InstallPluginDialog
          plugin={{
            id: pendingInstall.item.id,
            name: pendingInstall.item.displayName || pendingInstall.item.name,
            publisher: pendingInstall.item.author || pendingInstall.item.sourceLabel,
            version: pendingInstall.item.version,
            logoUrl: pendingInstallLogo?.url,
            logoContrastPad: pendingInstallLogo?.contrastPad,
            useLogoInitial: pendingInstallLogo?.source === 'fallback',
            logoDistribution: marketplacePluginDistribution(pendingInstall.item),
            componentCount: marketplaceComponentCount(pendingInstall.item),
            requiredConnectionNames: pendingInstall.requiredConnectionNames,
          }}
          onCancel={() => setPendingInstall(null)}
          onConfirm={() => executeMarketplaceInstall()}
        />
      )}
      {pendingPluginUninstall && (
        <UninstallPluginDialog
          pluginName={pendingPluginUninstall.name}
          onCancel={() => setPendingPluginUninstall(null)}
          onConfirm={confirmUninstallPlugin}
        />
      )}
      {pendingPersonalPluginDelete && (
        <DeletePersonalPluginDialog
          pluginName={pendingPersonalPluginDelete.displayName}
          installed={pendingPersonalPluginDelete.installedId !== null}
          published={pendingPersonalPluginDelete.cloudPluginId !== null}
          publicationActive={pendingPersonalPluginDelete.publication !== null}
          impact={pendingPersonalPluginDelete.impact}
          deleting={isDeletingPersonalPlugin}
          onCancel={() => {
            if (!isDeletingPersonalPlugin) setPendingPersonalPluginDelete(null)
          }}
          onConfirm={() => void confirmDeletePersonalPlugin()}
        />
      )}
      {pendingLocalConnectorAuth ? (
        <LocalConnectorAuthDialog
          open
          target={pendingLocalConnectorAuth.target}
          title={pendingLocalConnectorAuth.title}
          onSuccess={() => {
            const pending = pendingLocalConnectorAuth
            setPendingLocalConnectorAuth(null)
            pending.resolve()
          }}
          onCancel={() => {
            const pending = pendingLocalConnectorAuth
            setPendingLocalConnectorAuth(null)
            pending.reject(
              new Error(t('workbench.plugins_local_auth_cancelled', '已取消授权，安装已终止'))
            )
          }}
        />
      ) : null}
      {showPluginImportDialog ? (
        <PluginImportDialog
          pluginApi={localPluginApi}
          onCancel={() => setShowPluginImportDialog(false)}
          onImported={imported => {
            setShowPluginImportDialog(false)
            notifyLocalPluginSkillsChanged()
            setPluginOperationNotice({
              id: 'plugin-import-complete',
              kind: 'success',
              message: t(
                'workbench.plugins_import_success_auth_deferred',
                '插件已导入并安装。如需连接器授权，可稍后在插件详情中登录。'
              ),
              actionLabel: t('workbench.plugins_import_view_plugin', '查看插件'),
              onAction: () => {
                const personalKey = localMarketplaceKey(WEWORK_PERSONAL_MARKETPLACE_ID)
                rememberMarketplaceKey(personalKey)
                setSelectedMarketplaceKey(personalKey)
                setMarketplaceSourceFilterKey(personalKey)
                setPluginOperationNotice(null)
                setQuery(imported.pluginName)
              },
            })
            refreshLocalMarketplace()
          }}
        />
      ) : null}
    </>
  )

  const openMarketplacePluginDetail = (item: PluginMarketplaceItem) => {
    marketplaceReturnScrollTopRef.current = marketplaceScrollRegionRef.current?.scrollTop ?? 0
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

  const marketplaceRowActionRef = useRef({
    open: openMarketplacePluginDetail,
    install: installMarketplacePlugin,
    try: tryMarketplacePluginInChat,
    copy: (item: PluginMarketplaceItem) => {
      void copyMarketplacePlugin(item)
    },
    uninstall: (item: PluginMarketplaceItem) => {
      requestUninstallPlugin(marketplaceUninstallId(item), item.displayName || item.name)
    },
  })
  marketplaceRowActionRef.current = {
    open: openMarketplacePluginDetail,
    install: installMarketplacePlugin,
    try: tryMarketplacePluginInChat,
    copy: (item: PluginMarketplaceItem) => {
      void copyMarketplacePlugin(item)
    },
    uninstall: (item: PluginMarketplaceItem) => {
      requestUninstallPlugin(marketplaceUninstallId(item), item.displayName || item.name)
    },
  }
  const handleMarketplaceRowAction = useCallback(
    (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => {
      if (action === 'open' || action === 'manage') {
        setBrowsingCategoryKey(null)
        marketplaceRowActionRef.current.open(item)
        return
      }
      if (action === 'install') {
        void marketplaceRowActionRef.current.install(item)
        return
      }
      if (action === 'try') {
        setBrowsingCategoryKey(null)
        marketplaceRowActionRef.current.try(item)
        return
      }
      if (action === 'copy') {
        marketplaceRowActionRef.current.copy(item)
        return
      }
      marketplaceRowActionRef.current.uninstall(item)
    },
    [setBrowsingCategoryKey]
  )
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
      setSelectedMarketplaceKey(marketplace.key)
      selectLocalMarketplaceTab(marketplace.key)
    },
    [selectLocalMarketplaceTab]
  )
  const handleClearMarketplaceFilters = useCallback(() => {
    marketplaceSearchInputRef.current?.clear()
    rememberMarketplaceKey('')
    setSelectedMarketplaceKey(cloudMarketplaceKey())
    clearMarketplaceFilters()
  }, [clearMarketplaceFilters])
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

  if (selectedPlugin) {
    const ownedMarketplace = findOwnedMarketplacePlugin(selectedPlugin)
    const selectedPluginPublications = matchingPublicationRequests(
      publicationRequests,
      ownedMarketplace?.visibility === 'personal' ? Number(ownedMarketplace.id) : null,
      createdPluginSlug(selectedPlugin)
    )
    const selectedPublication = selectPrimaryPublication(selectedPluginPublications)
    const packableCreated =
      findPackableCreatedPlugin(installedPlugins, [
        selectedPlugin.raw.spec.source.pluginKey,
        createdPluginSlug(selectedPlugin),
        selectedPlugin.name,
        ownedMarketplace?.name,
        ownedMarketplace?.displayName,
      ]) ?? (selectedPlugin.origin === 'created' ? selectedPlugin : null)
    const ownerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing: ownedMarketplace ?? null,
    })
    const continueEditingKey = resolveContinueEditingPluginKey({
      packableCreated,
      currentPlugin: selectedPlugin,
      ownedListingName: ownedMarketplace?.name,
      isPersonalOwner:
        ownedMarketplace?.accessRole === 'owner' && ownedMarketplace.visibility === 'personal',
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
    const selectedDeviceInstallation = currentDeviceInstallation(
      selectedPlugin.raw,
      currentDeviceId
    )
    const selectedAutoUpdatePaused = marketplaceItemHasPausedPluginAutoUpdate({
      updateAvailable: selectedPlugin.updateAvailable,
      currentDeviceInstallation: selectedDeviceInstallation,
    })
    const headerBusy = pluginPublishPreparing || isUploadingPlugin || submissionStatus === 'pending'
    const openOwnerShare = () => void openCreatedPluginAccess(selectedPlugin)
    const openOwnerPublish = () =>
      openPackablePublish(
        [
          selectedPlugin.raw.spec.source.pluginKey,
          createdPluginSlug(selectedPlugin),
          selectedPlugin.name,
          ownedMarketplace?.name,
          ownedMarketplace?.displayName,
        ],
        selectedPlugin
      )
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          actionError={pluginDetailActionErrorMessage(pluginDetailActionError, selectedPlugin.id)}
          usableOnThisDevice={pluginDetailReadyToTry(selectedPlugin, ownedMarketplace)}
          primaryActionLabel={t('workbench.plugins_try_now', '立即对话')}
          shareActionLabel={t('workbench.plugins_share', '分享')}
          shareActionDisabled={headerBusy}
          onShareAction={ownerActions.showShareAction ? openOwnerPublish : undefined}
          publication={selectedPublication}
          publicationWithdrawing={withdrawingPublicationId === selectedPublication?.id}
          onViewPublication={
            selectedPublication
              ? selectedPublication.actionEligibility.canViewEnterprisePlugin
                ? () => void openPublishedEnterprisePlugin(selectedPublication)
                : () => void openPublicationProgress(selectedPublication.id)
              : undefined
          }
          onWithdrawPublication={
            selectedPublication?.actionEligibility?.canWithdraw
              ? () => void openPublicationProgress(selectedPublication.id)
              : undefined
          }
          onCreatePublicationRevision={
            selectedPublication?.actionEligibility?.canCreateRevision
              ? () => openPublicationRevision(selectedPublication)
              : undefined
          }
          publicationHistoryCount={selectedPluginPublications.length}
          onViewPublicationHistory={
            selectedPublication && selectedPluginPublications.length > 1
              ? () => void openPublicationProgress(selectedPublication.id)
              : undefined
          }
          accessRole={ownedMarketplace?.accessRole}
          pluginVisibility={ownedMarketplace?.visibility ?? null}
          shareGrantUserCount={ownedMarketplace?.grantUserCount ?? 0}
          shareGrantNamespaceCount={ownedMarketplace?.grantNamespaceCount ?? 0}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={ownerActions.canManageAccess ? openOwnerShare : undefined}
          submissionStatus={submissionStatus}
          submissionReviewNote={submissionReviewNote}
          onBack={() => closePluginDetail(() => setSelectedPluginId(null))}
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          deleteActionLabel={t('workbench.plugins_delete_plugin', '删除插件')}
          deleteActionDisabled={headerBusy}
          onDeleteAction={
            packableCreated
              ? () =>
                  void requestDeletePersonalPlugin({
                    pluginName: packableCreated.raw.spec.source.pluginKey,
                    displayName: selectedPlugin.name,
                    marketplacePath:
                      typeof packableCreated.raw.spec.sourcePayload?.marketplacePath === 'string'
                        ? packableCreated.raw.spec.sourcePayload.marketplacePath
                        : null,
                    installedId: packableCreated.id,
                  })
              : undefined
          }
          onToggle={() => {
            if (!tryPluginInChat(selectedPlugin.raw)) {
              setPluginDetailActionError({
                pluginId: selectedPlugin.id,
                message: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
              })
            }
          }}
          onPromptSelect={prompt => {
            if (queuePluginPromptTrial(selectedPlugin.raw, prompt, { openInNewChat: true })) {
              navigateTo('/')
            }
          }}
          onComponentToggle={(componentKey, enabled) =>
            togglePluginComponent(selectedPlugin.id, componentKey, enabled)
          }
          autoUpdateEnabled={selectedPlugin.raw.spec.updatePolicy === 'auto'}
          autoUpdateSaving={updatingPluginPolicyIds.has(selectedPlugin.id)}
          autoUpdatePaused={
            selectedPlugin.raw.spec.updatePolicy === 'auto' && selectedAutoUpdatePaused
          }
          autoUpdateFailureCount={selectedDeviceInstallation?.attemptCount ?? 0}
          onAutoUpdateChange={
            isCloudManagedInstalledPlugin(selectedPlugin.raw)
              ? enabled => changePluginAutoUpdatePolicy(selectedPlugin, enabled)
              : undefined
          }
          onUninstall={() => requestUninstallPlugin(selectedPlugin.id, selectedPlugin.name)}
          onManageConnector={slug => void managePluginConnector(slug, selectedPlugin)}
          connectorAuthBySlug={localConnectorAuthBySlug}
        />
        {pluginShareDialog}
        {pluginPublishDialog}
        {publicationProgressDrawer}
        {pluginOperationNoticeOverlay}
        {pluginOverlayDialogs}
      </>
    )
  }

  if (selectedMarketplacePlugin) {
    const installedDetail = findInstalledPluginForMarketplaceItem(
      selectedMarketplacePlugin,
      installedPlugins
    )
    const baseDetailPlugin = installedDetail
      ? withMarketplaceListingInterface(installedDetail, selectedMarketplacePlugin)
      : toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)
    const detailPlugin = selectedMarketplacePluginDetail ?? baseDetailPlugin
    const detailedMarketplacePlugin = withMarketplaceDetailComponents(
      selectedMarketplacePlugin,
      detailPlugin
    )
    const declaredConnectionNames = requiredConnectionNames(detailedMarketplacePlugin)
    const detailRequiredConnectionNames = selectedRequiredConnectionNames ?? declaredConnectionNames
    const detailRequiresConnection = detailRequiredConnectionNames.length > 0
    const deviceState = selectedMarketplacePlugin.currentDeviceInstallation?.state
    const isInstalled = pluginDetailReadyToTry(detailPlugin, selectedMarketplacePlugin)
    const isFailed = marketplaceItemOffersDeviceSyncRetry(selectedMarketplacePlugin, {
      autoSyncSettled: deviceAutoSyncSettled,
    })
    const isDeviceSyncing =
      !isFailed &&
      !isInstalled &&
      (deviceState === 'pending' ||
        deviceState === 'downloading' ||
        deviceState === 'installing' ||
        deviceState === 'uninstalling')
    const isInstalling = installingMarketplacePluginIds.has(selectedMarketplacePlugin.id)
    const detailUninstallId = installedDetail?.id ?? selectedMarketplacePlugin.installedPluginId
    const isUninstalling =
      detailUninstallId !== null &&
      detailUninstallId !== undefined &&
      uninstallingPluginIds.has(detailUninstallId)
    const isActionPending = isInstalling || isUninstalling || isDeviceSyncing
    const canUpdate =
      marketplaceItemCanRetryPluginUpdate(selectedMarketplacePlugin) &&
      selectedMarketplacePlugin.installed &&
      selectedMarketplacePlugin.installedPluginId
    const autoUpdatePaused = marketplaceItemHasPausedPluginAutoUpdate(selectedMarketplacePlugin)
    const showDetailActionMenu =
      isInstalled ||
      (selectedMarketplacePlugin.installedPluginId !== null &&
        selectedMarketplacePlugin.installedPluginId !== undefined)
    const marketplacePrimaryIcon: 'try' | 'install' | 'none' = isActionPending
      ? 'none'
      : isInstalled
        ? 'try'
        : 'install'
    const detailMarketplaceId = marketplaceItemMarketplaceId(selectedMarketplacePlugin) || ''
    const ownedListing =
      selectedMarketplacePlugin.accessRole === 'owner' ? selectedMarketplacePlugin : null
    const packableCreated = marketplaceItemOwnsLocalCreatedPackage(selectedMarketplacePlugin)
      ? (findPackableCreatedPlugin(installedPlugins, [
          selectedMarketplacePlugin.name,
          selectedMarketplacePlugin.displayName,
          installedDetail?.raw.spec.source.pluginKey,
          installedDetail?.name,
        ]) ?? (installedDetail?.origin === 'created' ? installedDetail : null))
      : null
    const isOwnedPersonalListing =
      selectedMarketplacePlugin.accessRole === 'owner' &&
      selectedMarketplacePlugin.visibility === 'personal'
    const originPersonalListing = selectedMarketplacePlugin.originPersonalPluginId
      ? (pluginMarketplaceState.items.find(
          item =>
            String(item.id) === String(selectedMarketplacePlugin.originPersonalPluginId) &&
            item.visibility === 'personal' &&
            item.accessRole === 'owner'
        ) ?? null)
      : null
    const marketplacePluginPublications = isOwnedPersonalListing
      ? matchingPublicationRequests(
          publicationRequests,
          Number(selectedMarketplacePlugin.id),
          selectedMarketplacePlugin.name
        )
      : []
    const marketplacePublication = selectPrimaryPublication(marketplacePluginPublications)
    const hasDeletablePersonalSource =
      selectedMarketplacePlugin.accessRole !== 'recipient' &&
      (Boolean(packableCreated) ||
        Boolean(selectedMarketplacePlugin.localPersonalSource) ||
        (isPersonalMarketplaceId(detailMarketplaceId) &&
          selectedMarketplacePlugin.latestReleaseId == null))
    const marketplaceOwnerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing,
    })
    const continueEditingKey = resolveContinueEditingPluginKey({
      packableCreated,
      currentPlugin: installedDetail,
      ownedListingName: ownedListing?.name,
      isPersonalOwner: ownedListing?.visibility === 'personal',
    })
    const openMarketplaceOwnerShare = () => void openPluginShare(selectedMarketplacePlugin)
    const openMarketplaceOwnerPublish = () =>
      openPackablePublish(
        [
          selectedMarketplacePlugin.name,
          selectedMarketplacePlugin.displayName,
          installedDetail?.raw.spec.source.pluginKey,
          installedDetail?.name,
        ],
        installedDetail
      )

    return (
      <>
        <PluginDetailView
          plugin={detailPlugin}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          usableOnThisDevice={isInstalled}
          accessRole={selectedMarketplacePlugin.accessRole}
          pluginVisibility={selectedMarketplacePlugin.visibility}
          shareGrantUserCount={selectedMarketplacePlugin.grantUserCount ?? 0}
          shareGrantNamespaceCount={selectedMarketplacePlugin.grantNamespaceCount ?? 0}
          shareRecipient={selectedMarketplacePlugin.accessRole === 'recipient'}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={
            marketplaceOwnerActions.canManageAccess ? openMarketplaceOwnerShare : undefined
          }
          shareActionLabel={t('workbench.plugins_share', '分享')}
          shareActionDisabled={pluginPublishPreparing || isUploadingPlugin || pluginSharePreparing}
          onShareAction={
            marketplaceOwnerActions.showShareAction
              ? packableCreated
                ? openMarketplaceOwnerPublish
                : openMarketplaceOwnerShare
              : undefined
          }
          publication={marketplacePublication}
          publicationWithdrawing={withdrawingPublicationId === marketplacePublication?.id}
          onViewPublication={
            marketplacePublication
              ? marketplacePublication.actionEligibility.canViewEnterprisePlugin
                ? () => void openPublishedEnterprisePlugin(marketplacePublication)
                : () => void openPublicationProgress(marketplacePublication.id)
              : undefined
          }
          onWithdrawPublication={
            marketplacePublication?.actionEligibility?.canWithdraw
              ? () => void openPublicationProgress(marketplacePublication.id)
              : undefined
          }
          onCreatePublicationRevision={
            marketplacePublication?.actionEligibility?.canCreateRevision
              ? () => openPublicationRevision(marketplacePublication)
              : undefined
          }
          publicationHistoryCount={marketplacePluginPublications.length}
          onViewPublicationHistory={
            marketplacePublication && marketplacePluginPublications.length > 1
              ? () => void openPublicationProgress(marketplacePublication.id)
              : undefined
          }
          originPersonalActionLabel={t(
            'workbench.plugin_detail_view_origin_personal',
            '查看个人创建版本'
          )}
          onOpenOriginPersonalPlugin={
            originPersonalListing
              ? () =>
                  navigateTo(
                    buildPluginDetailRoute({
                      pluginName: originPersonalListing.name,
                      marketplaceName: WEWORK_PERSONAL_MARKETPLACE_ID,
                    })
                  )
              : undefined
          }
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          deleteActionLabel={t('workbench.plugins_delete_plugin', '删除插件')}
          deleteActionDisabled={pluginPublishPreparing || isActionPending}
          onDeleteAction={
            isOwnedPersonalListing || hasDeletablePersonalSource
              ? () =>
                  void requestDeletePersonalPlugin({
                    pluginName:
                      selectedMarketplacePlugin.localPersonalSource?.pluginName ||
                      selectedMarketplacePlugin.name,
                    displayName:
                      selectedMarketplacePlugin.displayName || selectedMarketplacePlugin.name,
                    marketplacePath:
                      typeof packableCreated?.raw.spec.sourcePayload?.marketplacePath === 'string'
                        ? packableCreated.raw.spec.sourcePayload.marketplacePath
                        : selectedMarketplacePlugin.localPersonalSource?.marketplacePath
                          ? selectedMarketplacePlugin.localPersonalSource.marketplacePath
                          : typeof selectedMarketplacePlugin.manifest.marketplacePath === 'string'
                            ? selectedMarketplacePlugin.manifest.marketplacePath
                            : null,
                    installedId: packableCreated?.id ?? null,
                    cloudPluginId: isOwnedPersonalListing ? selectedMarketplacePlugin.id : null,
                    deleteLocalSource: hasDeletablePersonalSource,
                  })
              : undefined
          }
          isExternalSource={
            selectedMarketplacePlugin.sourceProvider === 'codex' ||
            marketplacePluginDistribution(selectedMarketplacePlugin) === 'public'
          }
          actionError={
            (isFailed && selectedMarketplacePlugin.currentDeviceInstallation?.errorMessage) ||
            pluginDetailActionErrorMessage(pluginDetailActionError, selectedMarketplacePlugin.id)
          }
          primaryActionLabel={
            isActionPending
              ? isUninstalling
                ? t('workbench.plugins_uninstalling', '正在卸载')
                : isInstalling
                  ? t('workbench.plugins_installing', '正在安装')
                  : t('workbench.plugins_syncing_installation', '同步中...')
              : canUpdate
                ? t('workbench.plugins_update', '更新')
                : isInstalled
                  ? t('workbench.plugins_try_now', '立即对话')
                  : isFailed
                    ? t('workbench.plugins_retry_install', '重试安装')
                    : detailRequiresConnection
                      ? t('workbench.plugins_install_and_connect_named', '安装并连接 {{name}}', {
                          name:
                            detailRequiredConnectionNames[0] ||
                            selectedMarketplacePlugin.displayName ||
                            selectedMarketplacePlugin.name,
                        })
                      : t('workbench.plugins_install_plugin', '安装插件')
          }
          primaryActionIcon={marketplacePrimaryIcon}
          primaryActionDisabled={isActionPending}
          tertiaryActionLabel={
            selectedMarketplacePlugin.accessRole === 'recipient' &&
            selectedMarketplacePlugin.allowCopy
              ? t('workbench.plugins_copy_to_personal', '复制到我的插件')
              : undefined
          }
          tertiaryActionDisabled={pluginSharePreparing}
          onTertiaryAction={
            selectedMarketplacePlugin.accessRole === 'recipient' &&
            selectedMarketplacePlugin.allowCopy
              ? () => void copyMarketplacePlugin(selectedMarketplacePlugin)
              : undefined
          }
          showUninstall={showDetailActionMenu}
          onBack={() => closePluginDetail(() => setSelectedMarketplacePluginId(null))}
          onToggle={() => {
            if (canUpdate) {
              installMarketplacePlugin(selectedMarketplacePlugin)
              return
            }
            if (isInstalled) {
              beginMarketplacePluginTrial(selectedMarketplacePlugin, detailPlugin)
              return
            }
            installMarketplacePlugin(detailedMarketplacePlugin)
          }}
          onComponentToggle={(componentKey, enabled) => {
            if (installedDetail) {
              togglePluginComponent(installedDetail.id, componentKey, enabled)
            }
          }}
          autoUpdateEnabled={installedDetail?.raw.spec.updatePolicy === 'auto'}
          autoUpdateSaving={
            installedDetail ? updatingPluginPolicyIds.has(installedDetail.id) : false
          }
          autoUpdatePaused={
            Boolean(installedDetail?.raw.spec.updatePolicy === 'auto') && autoUpdatePaused
          }
          autoUpdateFailureCount={
            selectedMarketplacePlugin.currentDeviceInstallation?.attemptCount ?? 0
          }
          onAutoUpdateChange={
            installedDetail && isCloudManagedInstalledPlugin(installedDetail.raw)
              ? enabled => changePluginAutoUpdatePolicy(installedDetail, enabled)
              : undefined
          }
          onUninstall={() => {
            requestUninstallPlugin(
              marketplaceUninstallId(selectedMarketplacePlugin),
              selectedMarketplacePlugin.displayName || selectedMarketplacePlugin.name
            )
          }}
          onPromptSelect={prompt => {
            if (isInstalled) {
              beginMarketplacePluginTrial(selectedMarketplacePlugin, detailPlugin, prompt)
              return
            }
            installMarketplacePlugin(detailedMarketplacePlugin, prompt)
          }}
          onManageConnector={slug =>
            void managePluginConnector(slug, installedDetail ?? selectedMarketplacePlugin)
          }
          connectorAuthBySlug={localConnectorAuthBySlug}
        />
        {pluginShareDialog}
        {pluginPublishDialog}
        {publicationProgressDrawer}
        {pluginOperationNoticeOverlay}
        {pluginOverlayDialogs}
      </>
    )
  }

  return (
    <main
      data-testid="plugins-workspace"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background text-text-primary"
    >
      <div
        data-testid="plugins-page-content"
        className={[
          'mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col px-5 md:px-10',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          topBarLeftActions ? 'pt-3 md:pt-4' : 'pt-6 md:pt-7',
        ].join(' ')}
      >
        {topBarLeftActions ? (
          <div className="mb-3 flex min-h-8 items-center gap-2 md:mb-4">
            <div data-testid="plugins-topbar-left-actions" className="shrink-0">
              {topBarLeftActions}
            </div>
            <div
              data-testid="plugins-topbar-drag-region"
              className="min-h-8 min-w-0 flex-1 self-stretch"
            >
              <MacOSTitleBarDragRegion className="h-full w-full" />
            </div>
          </div>
        ) : null}

        <header
          data-testid="plugins-topbar"
          className="plugin-market-header relative flex items-start justify-between gap-6"
        >
          {!topBarLeftActions ? (
            <div
              data-testid="plugins-topbar-drag-region"
              className="pointer-events-none absolute inset-x-0 top-0 hidden min-h-[52px] md:block"
              aria-hidden="true"
            >
              <MacOSTitleBarDragRegion className="h-full w-full" />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="sr-only">{t('workbench.plugin_management_tab_plugins', '插件')}</h2>
            <h1 className="plugin-market-title text-text-primary">
              {t('workbench.plugins_marketplace_title', '插件市场')}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-text-secondary">
              {t(
                'workbench.plugins_marketplace_subtitle',
                '发现并接入开发工具、企业数据和专业方法。'
              )}
            </p>
            <span className="sr-only">
              {t('workbench.plugins_subtitle', '通过插件扩展 WeWork 能力')}
            </span>
          </div>
          <div
            data-testid="plugins-topbar-right-actions"
            className="flex w-full max-w-[420px] shrink-0 items-center justify-between gap-3 sm:w-auto"
          >
            <div className="flex items-center gap-2 md:gap-[9px]">
              <button
                type="button"
                data-testid="plugins-refresh-button"
                aria-label={t('workbench.plugins_refresh_marketplace', '刷新插件市场')}
                disabled={pluginMarketplaceState.isLoading || isMarketplaceRefreshing}
                className="plugin-market-icon-button hidden disabled:opacity-50 md:inline-flex"
                onClick={refreshMarketplace}
              >
                <RefreshCw
                  className={[
                    'h-4 w-4',
                    pluginMarketplaceState.isLoading || isMarketplaceRefreshing
                      ? 'animate-spin'
                      : '',
                  ].join(' ')}
                />
              </button>
              <PluginCreateMenu
                isOpen={isCreateMenuOpen}
                onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                onCreatePlugin={openPluginCreator}
                onImportPlugin={() => {
                  setIsCreateMenuOpen(false)
                  setShowPluginImportDialog(true)
                }}
                onAddMarket={() => {
                  setIsCreateMenuOpen(false)
                  setShowAddMarketDialog(true)
                }}
              />
            </div>
            <button
              type="button"
              data-testid="plugins-manage-button"
              className="plugin-market-action-button"
              onClick={() => navigateTo('/plugins/manage')}
            >
              <Settings2 className="h-[17px] w-[17px]" aria-hidden="true" />
              {t('workbench.plugins_manage_plugins', '管理插件')}
            </button>
          </div>
        </header>

        <MarketplaceCatalogView
          hasMarketplace={hasMarketplace}
          marketplaces={marketplaces}
          selectedMarketplaceKey={selectedMarketplaceKey}
          selectedDistributionTab={selectedDistributionTab}
          marketplaceSourceFilterKey={marketplaceSourceFilterKey}
          marketplaceDistributionLabels={marketplaceDistributionLabels}
          localMarketplaceTabs={localMarketplaceTabs}
          query={query}
          searchInputRef={marketplaceSearchInputRef}
          scrollRef={marketplaceScrollRegionRef}
          showInstalledStrip={showInstalledStrip}
          installedStrip={
            showInstalledStrip ? (
              <InstalledPluginStrip
                plugins={installedStripPlugins}
                hiddenPlugins={hiddenInstalledPlugins}
                marketplaceItems={pluginMarketplaceState.items}
                sidebarCollapsed={sidebarCollapsed}
                onOpen={openInstalledPluginDetail}
              />
            ) : null
          }
          pluginMarketplaceState={pluginMarketplaceState}
          marketplaceLoadingMessage={marketplaceLoadingMessage}
          isMarketplaceRefreshing={isMarketplaceRefreshing}
          isMarketplaceSearchUpdating={isMarketplaceSearchUpdating}
          isOpenAiOfficialViewLoading={isOpenAiOfficialViewLoading}
          normalizedQuery={normalizedQuery}
          visibleMarketplaceItems={visibleMarketplaceItems}
          marketplaceCategorySections={marketplaceCategorySections}
          visibleSearchResultLimit={visibleSearchResultLimit}
          isLoggedIn={Boolean(cloudToken && currentDeviceId)}
          installingMarketplacePluginIds={installingMarketplacePluginIds}
          uninstallingPluginIds={uninstallingPluginIds}
          allowPendingRetry={deviceAutoSyncSettled || !deviceCloudConnected}
          showPendingAsSyncing={localInventoryReady && deviceCloudConnected}
          rowLabels={marketplaceRowLabels}
          onSelectDistributionTab={handleSelectDistributionTab}
          onSelectLocalMarketplaceTab={handleSelectLocalMarketplaceTab}
          onQueryChange={setQuery}
          onRefresh={refreshMarketplace}
          onClearFilters={handleClearMarketplaceFilters}
          onRevealMore={handleRevealMore}
          onAction={handleMarketplaceRowAction}
        />
      </div>
      {pluginOverlayDialogs}
      {pluginOperationNoticeOverlay}
      {browsingCategorySection && (
        <CategoryBrowseDialog
          section={browsingCategorySection}
          isLoggedIn={Boolean(cloudToken && currentDeviceId)}
          installingMarketplacePluginIds={installingMarketplacePluginIds}
          uninstallingPluginIds={uninstallingPluginIds}
          allowPendingRetry={deviceAutoSyncSettled || !deviceCloudConnected}
          showPendingAsSyncing={localInventoryReady && deviceCloudConnected}
          rowLabels={marketplaceRowLabels}
          onClose={() => setBrowsingCategoryKey(null)}
          onAction={handleMarketplaceRowAction}
        />
      )}
      {showAddMarketDialog && (
        <AddMarketDialog
          isOpen={showAddMarketDialog}
          isSubmitting={isAddingMarket}
          formData={addMarketForm}
          onClose={() => setShowAddMarketDialog(false)}
          onChange={setAddMarketForm}
          onSubmit={addMarketplace}
        />
      )}
      {pluginShareDialog}
      {pluginPublishDialog}
    </main>
  )
}
