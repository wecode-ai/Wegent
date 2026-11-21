import { getToken } from '@/api/auth'
import { getRuntimeConfig } from '@/config/runtime'
import {
  createLocalDevicePluginApi,
  resolveLocalPluginDeviceRouteId,
} from '@/features/plugins/pluginDeviceApi'
import { usePluginRefreshReconciliation } from '../hooks/usePluginRefreshReconciliation'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { useDOMEvent, useWindowEvent, useDocumentEvent } from '@wegent/collaboration/dom-events'
import { createPluginCatalogState } from '../workspace/pluginCatalogState'
import {
  clearLocalCodexPluginsReadStateCache,
  readPluginReconciliationInventory,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
import { getErrorMessage } from '@/lib/error-message'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { useLocalExecutorCloudConnectionStatus } from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import { pluginMarketplaceCacheKey } from '@/features/plugins/pluginMarketplaceCache'
import {
  markPluginDeviceAutoSyncAttempted,
  markPluginDeviceAutoSyncSettled,
} from '@/features/plugins/pluginDeviceAutoSync'
import { PLUGIN_AUTO_UPDATE_COMPLETED_EVENT } from '@/features/plugins/pluginAutoUpdateEvents'
import { createDefaultPluginApi } from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginCatalogInput } from './pluginCatalogState'
import type { PluginWorkspaceServices } from './pluginWorkspaceTypes'

export function usePluginWorkspaceCatalog({
  cloudApiBaseUrl,
  cloudToken,
  cloudMarketplaceAvailable,
  t,
  localExecutorCloudConnection,
  installingMarketplacePluginIds,
  uninstallingPluginIds,
  updatingPluginPolicyIds,
  pendingLocalConnectorAuth,
  onReconciliationComplete,
}: {
  cloudApiBaseUrl: string | undefined
  cloudToken: string | null | undefined
  cloudMarketplaceAvailable: boolean
  t: PluginCatalogInput['t']
  localExecutorCloudConnection: ReturnType<typeof useLocalExecutorCloudConnectionStatus>
  installingMarketplacePluginIds: Set<string | number>
  uninstallingPluginIds: Set<string>
  updatingPluginPolicyIds: Set<string | number>
  pendingLocalConnectorAuth: ReturnType<
    PluginWorkspaceServices['operations']['getSnapshot']
  >['pendingLocalConnectorAuth']
  onReconciliationComplete(): void
}) {
  const pluginRuntimeProfile = useMemo(
    () => ({
      apiBaseUrl: cloudApiBaseUrl || getRuntimeConfig().apiBaseUrl,
      token: cloudToken === undefined ? getToken() : cloudToken,
    }),
    [cloudApiBaseUrl, cloudToken]
  )
  const recoveryScopeKey = pluginMarketplaceCacheKey(
    pluginRuntimeProfile.apiBaseUrl,
    pluginRuntimeProfile.token
  )
  const accountPluginApi = useMemo(
    () => createDefaultPluginApi(pluginRuntimeProfile.apiBaseUrl, cloudToken),
    [cloudToken, pluginRuntimeProfile.apiBaseUrl]
  )
  const pluginApi = useMemo(
    () =>
      createLocalDevicePluginApi(
        accountPluginApi,
        deviceId => resolveLocalPluginDeviceRouteId(deviceId, pluginRuntimeProfile),
        pluginRuntimeProfile
      ),
    [accountPluginApi, pluginRuntimeProfile]
  )
  const localSyncResource = useMemo(
    () => createAsyncResource('local-plugin-sync', () => pluginApi.supportsLocalSync()),
    [pluginApi]
  )
  const subscribeLocalSync = useCallback(
    (listener: () => void) =>
      localSyncResource.subscribe(listener, localExecutorCloudConnection.connected),
    [localSyncResource, localExecutorCloudConnection.connected]
  )
  const localSyncAvailable =
    useSyncExternalStore(
      subscribeLocalSync,
      localSyncResource.getSnapshot,
      localSyncResource.getSnapshot
    ).data === true
  const deviceCloudConnected =
    localSyncAvailable ||
    (localExecutorCloudConnection.apiBaseUrl === (cloudApiBaseUrl || '') &&
      localExecutorCloudConnection.connected)
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const marketplaceCacheKeyValue = useMemo(
    () => pluginMarketplaceCacheKey(cloudApiBaseUrl, cloudToken),
    [cloudApiBaseUrl, cloudToken]
  )
  const knownExecutorDeviceId = isDesktopRuntime() ? getKnownLocalExecutorDeviceId() || '' : ''
  const pluginMutationInFlight =
    installingMarketplacePluginIds.size > 0 ||
    uninstallingPluginIds.size > 0 ||
    updatingPluginPolicyIds.size > 0
  const catalogInitial = {
    recoveryScopeKey,
    pluginApi,
    localPluginApi,
    cloudMarketplaceAvailable,
    cloudToken,
    knownExecutorDeviceId,
    t,
    deviceCloudConnected,
    pluginMutationInFlight,
    isReconcilingPlugins: false,
    installingMarketplacePluginIds,
    pendingLocalConnectorAuth,
  }
  const [catalogOwner, setCatalogOwner] = useState(() => ({
    key: marketplaceCacheKeyValue,
    device: knownExecutorDeviceId,
    source: createPluginCatalogState(marketplaceCacheKeyValue, catalogInitial),
  }))
  if (
    catalogOwner.key !== marketplaceCacheKeyValue ||
    catalogOwner.device !== knownExecutorDeviceId
  )
    setCatalogOwner({
      key: marketplaceCacheKeyValue,
      device: knownExecutorDeviceId,
      source: createPluginCatalogState(marketplaceCacheKeyValue, catalogInitial),
    })
  const catalog = catalogOwner.source
  const [reconciliationRevision, setReconciliationRevision] = useState(0)
  const reconciliationDeviceId = catalog.getSnapshot().currentDeviceId
  const reconciliation = usePluginRefreshReconciliation({
    request:
      catalog.getSnapshot().reconciliationScope.accountKey === marketplaceCacheKeyValue &&
      catalog.getSnapshot().reconciliationScope.deviceId === reconciliationDeviceId
        ? catalog.getSnapshot().reconciliationRequest
        : 0,
    accountKey: marketplaceCacheKeyValue,
    deviceId: reconciliationDeviceId,
    available: Boolean(cloudToken && cloudMarketplaceAvailable && deviceCloudConnected),
    busy: pluginMutationInFlight,
    localSync: localSyncAvailable,
    operations: {
      readStore: readPluginReconciliationInventory,
      sync: () => pluginApi.syncInstalledPluginsToDevice(reconciliationDeviceId, true),
      readCloud: async () => (await pluginApi.listInstalledPlugins(reconciliationDeviceId)).items,
      invalidate: () => {
        clearLocalCodexPluginsReadStateCache()
      },
    },
    onComplete: () => {
      if (
        !catalog.captureScope()() ||
        catalog.getSnapshot().currentDeviceId !== reconciliationDeviceId
      )
        return
      // A verified complete snapshot also satisfies background device-gap repair.
      markPluginDeviceAutoSyncAttempted(reconciliationDeviceId)
      markPluginDeviceAutoSyncSettled(reconciliationDeviceId)
      catalog.markReconciled()
      setReconciliationRevision(previous => previous + 1)
      catalog.refresh(false, true)
      onReconciliationComplete()
      catalog.showNotice({
        id: 'plugin-reconciliation-complete',
        kind: 'success',
        message: t('workbench.plugins_reconciliation_complete', '插件安装状态已核对并同步'),
      })
    },
    onError: error =>
      catalog.showNotice({
        id: 'plugin-reconciliation-error',
        kind: 'error',
        message: t('workbench.plugins_reconciliation_failed', '安装状态检查未完成：{{error}}', {
          error: getErrorMessage(error, 'Unknown error'),
        }),
      }),
  })
  const catalogInput = useMemo(
    () => ({
      recoveryScopeKey,
      pluginApi,
      localPluginApi,
      cloudMarketplaceAvailable,
      cloudToken,
      knownExecutorDeviceId,
      t,
      deviceCloudConnected,
      pluginMutationInFlight,
      isReconcilingPlugins: reconciliation.active,
      installingMarketplacePluginIds,
      pendingLocalConnectorAuth,
    }),
    [
      recoveryScopeKey,
      pluginApi,
      localPluginApi,
      cloudMarketplaceAvailable,
      cloudToken,
      knownExecutorDeviceId,
      t,
      deviceCloudConnected,
      pluginMutationInFlight,
      reconciliation.active,
      installingMarketplacePluginIds,
      pendingLocalConnectorAuth,
    ]
  )
  const subscribeCatalog = useCallback(
    (listener: () => void) => catalog.subscribe(catalogInput, listener),
    [catalog, catalogInput]
  )
  const {
    installedPlugins,
    pluginMarketplaceState,
    marketplaces,
    selectedMarketplaceKey,
    currentDeviceId,
    localInstalledStateReadyKey,
    isMarketplaceRefreshing,
    marketplaceLoadingMessage,
    deviceAutoSyncSettled,
    pluginOperationNotice,
  } = useSyncExternalStore(subscribeCatalog, catalog.getSnapshot, catalog.getSnapshot)
  const localInventoryReady = localInstalledStateReadyKey === marketplaceCacheKeyValue
  useWindowEvent('focus', catalog.revalidateCloud)
  useDocumentEvent('visibilitychange', () => {
    if (document.visibilityState === 'visible') catalog.revalidateCloud()
  })
  useDOMEvent('window', PLUGIN_AUTO_UPDATE_COMPLETED_EVENT, () => catalog.refresh(false))

  return {
    pluginApi,
    accountPluginApi,
    canInstallForAccount: Boolean(cloudMarketplaceAvailable && pluginRuntimeProfile.token),
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
  }
}
