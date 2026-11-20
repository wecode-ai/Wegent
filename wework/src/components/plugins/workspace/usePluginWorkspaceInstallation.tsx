import { recordPluginInstallationAccepted } from '@/features/plugins/pluginInstallTelemetry'
import { beginOperation, type OperationAttempt } from '@/telemetry/operationBus'
import {
  pluginDeviceReceiptPending,
  waitForPluginDeviceReceipt,
  PluginDeviceReceiptError,
  PluginInstallationSupersededError,
} from '@/features/plugins/waitForPluginDeviceReceipt'
import { useCallback, useState } from 'react'
import { requiresInstallConnectorAuth } from '@/features/plugins/connectorAuthPolicy'
import { listWegentConnectorApps } from '@/api/cloud/connectorApps'
import { trackPluginEvent as track } from '@/telemetry/businessEvents'
import { marketplacePluginTelemetryIdentity } from '@/telemetry/pluginIdentity'
import {
  isLocalConnector,
  localConnectorAuthHealth,
  localQrManageActionFromHealth,
} from '@/api/local/localConnectorAuth'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import { ensureLocalExecutorAvailable } from '@/desktop/localExecutor'
import { refreshLocalExecutorCloudConnectionStatus } from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import {
  notifyLocalPluginSkillsChanged,
  queuePluginPromptTrial,
} from '@/features/plugins/pluginTrial'
import { LocalConnectorPluginSyncTimeoutError } from '@/features/plugins/waitForLocalConnectorAuthAvailability'
import { getPluginMarketplaceCache } from '@/features/plugins/pluginMarketplaceCache'
import { commitPluginInventoryInstallation } from '@/features/plugins/pluginInventory'
import { marketplaceItemCanRetryPluginUpdate } from '@/features/plugins/pluginAutoUpdate'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { connectorDisplayName } from '../connectorDisplayName'
import { isLocalMarketplaceItem } from '../marketplaceCatalogMerge'
import { humanizeMarketplaceInstallError } from '../marketplaceInstallError'
import { marketplacePluginLockLabel, resolveMarketplacePluginLock } from '../marketplacePluginLock'
import { isOfficialMarketplacePlugin } from '../pluginDistribution'
import {
  currentDeviceInstallation,
  findInstalledPluginForMarketplaceItem,
  localMarketplaceIdFromItem,
  marketplaceComponentCount,
  marketplacePluginDetailSource,
  requiredConnectionNames,
  toInstalledPluginItem,
  withMarketplaceDetailComponents,
} from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginWorkspaceServices, PendingMarketplaceInstall } from './pluginWorkspaceTypes'

export function usePluginWorkspaceInstallation({
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
}: Pick<
  PluginWorkspaceServices,
  | 'selectedMarketplacePlugin'
  | 'selectedMarketplacePluginDetail'
  | 'localPluginApi'
  | 'catalog'
  | 'cloudApiBaseUrl'
  | 'cloudToken'
  | 't'
  | 'pluginApi'
  | 'localSyncResource'
  | 'isMarketplacePluginUninstalling'
  | 'reconciliationBlocksActions'
  | 'operations'
  | 'marketplaceCacheKeyValue'
  | 'installedPlugins'
  | 'beginMarketplacePluginTrial'
  | 'ensureMarketplaceConnectors'
  | 'rollbackInstalledPluginAfterAuthFailure'
  | 'ensureLocalConnectorsAfterInstall'
>) {
  const isPersonalSourceInstall = (item: PluginMarketplaceItem) =>
    item.accessRole === 'owner' && Boolean(item.localPersonalSource)
  const capturePluginScope = catalog.captureScope
  const [pendingInstall, setPendingInstall] = useState<PendingMarketplaceInstall | null>(null)
  const [pendingPluginUpdate, setPendingPluginUpdate] = useState<PluginMarketplaceItem | null>(null)

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
      const detail = await localPluginApi.readMarketplacePluginDetail(
        marketplacePluginDetailSource(item, catalog.getSnapshot().marketplaces),
        item.name
      )
      return withMarketplaceDetailComponents(item, toInstalledPluginItem(detail))
    } catch {
      return detailedItem
    }
  }

  const connectionNamesRequiredForInstall = useCallback(
    async (item: PluginMarketplaceItem): Promise<string[]> => {
      const requiredConnectors = (item.components.connectors ?? []).filter(
        requiresInstallConnectorAuth
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
    catalog.showNotice({
      id: `install-device-disconnected-${itemId}`,
      kind: 'error',
      message: t(
        'workbench.plugins_install_device_disconnected',
        '当前设备未连接到云端，暂时无法安装插件。请恢复连接后重试。'
      ),
      actionLabel: t('workbench.plugins_open_connection_settings', '连接设置'),
      onAction: () => {
        catalog.showNotice(null)
        navigateTo('/settings/connections')
      },
    })
  }

  const showDeviceIdentityUnavailableNotice = (itemId: string | number) => {
    catalog.showNotice({
      id: `install-device-identity-unavailable-${itemId}`,
      kind: 'error',
      message: t(
        'workbench.plugins_install_device_identity_unavailable',
        '当前设备信息尚未就绪，暂时无法安装插件。请稍后重试。'
      ),
    })
  }

  const rememberCurrentDeviceId = (deviceId: string) => {
    const normalizedDeviceId = deviceId.trim()
    if (!normalizedDeviceId || catalog.getSnapshot().currentDeviceId === normalizedDeviceId) {
      return normalizedDeviceId
    }
    catalog.rememberDevice(normalizedDeviceId)
    return normalizedDeviceId
  }

  const resolveLiveRuntimeCloudConnection = async (isCurrent: () => boolean) => {
    if (!cloudApiBaseUrl || !isCurrent())
      return { connected: false, deviceId: '', localSync: false }
    if (await pluginApi.supportsLocalSync()) {
      const executor = await ensureLocalExecutorAvailable({ refresh: true })
      if (!isCurrent()) return { connected: false, deviceId: '', localSync: false }
      localSyncResource.update(() => true)
      return {
        connected: true,
        deviceId: rememberCurrentDeviceId(executor.deviceId ?? ''),
        localSync: true,
      }
    }
    const status = await refreshLocalExecutorCloudConnectionStatus(cloudApiBaseUrl)
    if (!isCurrent()) return { connected: false, deviceId: '', localSync: false }
    if (status?.connected !== true) return { connected: false, deviceId: '', localSync: false }

    try {
      // Registration can replace a cached record route after reconnecting.
      // Refresh at the plugin operation boundary; retain stable inventory identity.
      const executor = await ensureLocalExecutorAvailable({ refresh: true })
      if (!isCurrent()) return { connected: false, deviceId: '', localSync: false }
      return {
        connected: true,
        localSync: false,
        deviceId: rememberCurrentDeviceId(executor.deviceId ?? ''),
      }
    } catch {
      if (!isCurrent()) return { connected: false, deviceId: '', localSync: false }
      return { connected: true, deviceId: '', localSync: false }
    }
  }

  const installMarketplacePlugin = async (
    item: PluginMarketplaceItem,
    promptAfterInstall?: string,
    updateConfirmed = false
  ) => {
    if (isMarketplacePluginUninstalling(item)) return
    const isCurrent = capturePluginScope()
    if (reconciliationBlocksActions) {
      catalog.showNotice({
        id: 'plugin-reconciliation-busy',
        kind: 'error',
        message: t('workbench.plugins_reconciliation_busy', '正在检查安装状态，请完成后再操作'),
      })
      return
    }
    const installLock = resolveMarketplacePluginLock(item)
    if (installLock) {
      catalog.showNotice({
        id: `install-locked-${item.id}`,
        kind: 'error',
        message: marketplacePluginLockLabel(installLock, t),
      })
      return
    }

    const alreadyInstalled = Boolean(item.installed || item.installedLocally)
    const installFromLocal =
      isLocalMarketplaceItem(item) || (!alreadyInstalled && isPersonalSourceInstall(item))
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

    if (
      operations.isPreparing(item.id) ||
      operations.getSnapshot().installingMarketplacePluginIds.has(item.id)
    )
      return
    operations.reservePreparation(item.id)
    let targetDeviceId = catalog.getSnapshot().currentDeviceId
    if (needsCloudPackagePush) {
      const liveConnection = await resolveLiveRuntimeCloudConnection(isCurrent).catch(error => {
        operations.releasePreparation(item.id)
        if (isCurrent()) {
          catalog.showNotice({
            id: `install-error-${item.id}`,
            kind: 'error',
            message: getErrorMessage(error, 'Unknown error'),
          })
        }
        return null
      })
      if (!liveConnection || !isCurrent() || isMarketplacePluginUninstalling(item)) {
        operations.releasePreparation(item.id)
        return
      }
      if (!liveConnection.connected) {
        operations.releasePreparation(item.id)
        showDeviceDisconnectedNotice(item.id)
        return
      }
      if (!liveConnection.localSync && !liveConnection.deviceId) {
        operations.releasePreparation(item.id)
        showDeviceIdentityUnavailableNotice(item.id)
        return
      }
      targetDeviceId = liveConnection.deviceId
    }

    if (alreadyInstalled) {
      if (
        marketplaceItemCanRetryPluginUpdate(item) &&
        item.latestReleaseId &&
        item.installedPluginId
      ) {
        if (!updateConfirmed) {
          operations.releasePreparation(item.id)
          setPendingPluginUpdate(item)
          return
        }
        catalog.dismissNotice(`update-error-${item.id}`)
        operations.beginInstall(item.id)
        pluginApi
          .updateMarketplacePlugin(
            item.installedPluginId,
            item.latestReleaseId,
            targetDeviceId,
            catalog.reportLocalProgress(`update-progress-${item.id}`, isCurrent)
          )
          .then(plugin => {
            if (!isCurrent()) return
            const device = currentDeviceInstallation(plugin, targetDeviceId)
            const marketplaceItems = (
              getPluginMarketplaceCache(marketplaceCacheKeyValue)?.marketplaceItems ??
              catalog.getSnapshot().pluginMarketplaceState.items
            ).map(candidate =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    currentDeviceInstallation: device,
                    updateAvailable:
                      device?.actualReleaseId !== item.latestReleaseId ||
                      device?.state !== 'installed',
                  }
                : candidate
            )
            commitPluginInventoryInstallation(
              marketplaceCacheKeyValue,
              targetDeviceId,
              plugin,
              marketplaceItems
            )
          })
          .catch((error: unknown) => {
            if (!isCurrent()) return
            if (catalog.showPendingRecovery(error)) return
            const message = getErrorMessage(error, 'Unknown error')
            catalog.showNotice({ id: `update-error-${item.id}`, kind: 'error', message })
          })
          .finally(() => {
            if (!isCurrent()) return
            operations.releasePreparation(item.id)
            operations.finishInstall(item.id)
          })
        return
      }
      const installed = findInstalledPluginForMarketplaceItem(item, installedPlugins)
      try {
        beginMarketplacePluginTrial(item, installed, promptAfterInstall)
      } finally {
        operations.releasePreparation(item.id)
      }
      return
    }
    if (operations.getSnapshot().installingMarketplacePluginIds.has(item.id)) {
      operations.releasePreparation(item.id)
      return
    }

    // Open the confirm dialog immediately. Do not wait on plugin/read, connector-apps,
    // or health probes — that made Install feel broken (no UI for seconds).
    const requiresConfirmation = !promptAfterInstall || !isOfficialMarketplacePlugin(item)
    if (requiresConfirmation) {
      setPendingInstall({
        item,
        requiredConnectionNames: requiredConnectionNames(item),
        promptAfterInstall,
      })
    }

    void prepareMarketplaceInstallItem(item)
      .then(async preparedItem => {
        if (!isCurrent()) return
        if (!requiresConfirmation) {
          executeMarketplaceInstall({
            item: preparedItem,
            requiredConnectionNames: [],
            promptAfterInstall,
          })
          return
        }
        const names = await connectionNamesRequiredForInstall(preparedItem)
        if (!isCurrent()) return
        setPendingInstall(previous => {
          if (!previous || String(previous.item.id) !== String(item.id)) return previous
          return {
            item: preparedItem,
            requiredConnectionNames: names,
            promptAfterInstall: previous.promptAfterInstall,
          }
        })
      })
      .catch(() => {
        // Keep the immediately opened dialog; confirm still uses the list-row item.
      })
      .finally(() => {
        if (!isCurrent()) return
        operations.releasePreparation(item.id)
      })
  }

  function executeMarketplaceInstall(install: PendingMarketplaceInstall | null = pendingInstall) {
    if (!install || reconciliationBlocksActions) return
    const { item: dialogItem, promptAfterInstall } = install
    if (operations.getSnapshot().installingMarketplacePluginIds.has(dialogItem.id)) return

    // Re-check lock against the latest catalog row. Stale-peek SWR can open the
    // confirm dialog before background plugin/list paints DISABLED_BY_ADMIN.
    const latestItem =
      catalog
        .getSnapshot()
        .pluginMarketplaceState.items.find(
          candidate => String(candidate.id) === String(dialogItem.id)
        ) ?? dialogItem
    if (isMarketplacePluginUninstalling(latestItem)) {
      setPendingInstall(null)
      return
    }
    const installLock = resolveMarketplacePluginLock(latestItem)
    if (installLock) {
      setPendingInstall(null)
      catalog.showNotice({
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
    const installPersonalSource = isPersonalSourceInstall(item)
    const installFromLocal = localMarketplaceId !== null || installPersonalSource
    const isCurrent = capturePluginScope()
    const requireCurrentScope = () => {
      if (!isCurrent()) throw new Error('Plugin account changed; retry with the current account')
      if (isMarketplacePluginUninstalling(item)) {
        throw new Error(t('workbench.plugins_uninstalling', '正在卸载'))
      }
    }

    setPendingInstall(null)
    operations.beginInstall(item.id)
    catalog.reportError(null)
    // Always re-prepare before connector auth + install. The confirm dialog opens
    // immediately with the list-row item; a fast confirm must not skip connector
    // detail that prepareMarketplaceInstallItem is still loading.
    let installRequestAttempt: OperationAttempt | null = null
    const request = prepareMarketplaceInstallItem(item)
      .then(async preparedItem => {
        requireCurrentScope()
        if (!installPersonalSource && (installFromLocal || !(await pluginApi.supportsLocalSync())))
          await ensureMarketplaceConnectors(preparedItem, isCurrent)
        requireCurrentScope()
        return preparedItem
      })
      .then(preparedItem => {
        requireCurrentScope()
        // Re-check lock after prepare/connectors — background refresh may have
        // painted DISABLED_BY_ADMIN while the dialog was open.
        const latest =
          catalog
            .getSnapshot()
            .pluginMarketplaceState.items.find(
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
        requireCurrentScope()
        installRequestAttempt = beginOperation('plugin.install_request', {
          properties: marketplacePluginTelemetryIdentity(preparedItem),
        })
        if (installPersonalSource) {
          const owner = await pluginApi.getMarketplacePluginOwner(preparedItem.id)
          requireCurrentScope()
          if (String(owner.pluginId) !== String(preparedItem.id)) {
            throw new Error('Published plugin source ownership could not be confirmed')
          }
          const plugin = await localPluginApi.installPersonalPluginSource(preparedItem, isCurrent)
          requireCurrentScope()
          return {
            plugin,
            preparedItem: { ...preparedItem, components: plugin.spec.components },
            targetDeviceId: catalog.getSnapshot().currentDeviceId,
          }
        }
        if (installFromLocal) {
          const plugin = await localPluginApi.installAvailablePlugin(preparedItem)
          requireCurrentScope()
          return {
            plugin,
            preparedItem,
            targetDeviceId: catalog.getSnapshot().currentDeviceId,
          }
        }
        const liveConnection = await resolveLiveRuntimeCloudConnection(isCurrent)
        requireCurrentScope()
        if (!liveConnection.connected) {
          throw Object.assign(new Error('Current device is disconnected'), {
            code: 'PLUGIN_DEVICE_DISCONNECTED',
          })
        }
        if (!liveConnection.localSync && !liveConnection.deviceId) {
          throw Object.assign(new Error('Current device identity is unavailable'), {
            code: 'PLUGIN_DEVICE_ID_UNAVAILABLE',
          })
        }
        const response = await pluginApi.installMarketplacePlugin(
          preparedItem.id,
          liveConnection.deviceId,
          catalog.reportLocalProgress(`install-progress-${preparedItem.id}`, isCurrent)
        )
        requireCurrentScope()
        return {
          plugin: response.plugin,
          preparedItem,
          targetDeviceId: liveConnection.deviceId,
        }
      })
      .then(async ({ plugin, preparedItem, targetDeviceId }) => {
        requireCurrentScope()
        installRequestAttempt?.succeed()
        if (!installFromLocal && pluginDeviceReceiptPending(plugin, targetDeviceId)) {
          // Account intent is committed. Fence older inventory reads immediately,
          // while the operation marker remains until the newest receipt settles.
          publishInstallation(plugin, targetDeviceId, false)
          plugin = await waitForPluginDeviceReceipt(plugin, targetDeviceId, {
            readInstalled: pluginApi.listInstalledPlugins,
            isCurrent: () =>
              isCurrent() && catalog.getSnapshot().currentDeviceId === targetDeviceId,
          })
          requireCurrentScope()
        }
        if (installPersonalSource) {
          try {
            await ensureMarketplaceConnectors(preparedItem, isCurrent)
            requireCurrentScope()
          } catch (error) {
            if (isCurrent()) await rollbackInstalledPluginAfterAuthFailure(plugin, isCurrent)
            throw error
          }
        }
        if (!plugin.status.localExecution)
          await ensureLocalConnectorsAfterInstall(preparedItem, plugin, isCurrent)
        requireCurrentScope()
        recordPluginInstallationAccepted(
          plugin,
          targetDeviceId,
          installFromLocal ? 'local' : 'cloud'
        )
        return { plugin, targetDeviceId }
      })

    const publishInstallation = (
      plugin: InstalledPlugin,
      targetDeviceId: string,
      settled = true
    ) => {
      const installed = toInstalledPluginItem(plugin)
      const deviceInstallation = installFromLocal
        ? null
        : currentDeviceInstallation(plugin, targetDeviceId)
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
      // Installation can finish after navigation. Merge into the latest shared
      // inventory, not the catalog captured by the initiating mounted view.
      const cachedInventory = getPluginMarketplaceCache(marketplaceCacheKeyValue)
      // Cloud catalog may paint before the first device identity resolves.
      // Bind that unscoped snapshot to the confirmed install device, but never
      // overwrite an inventory already owned by a different device.
      const currentInventory =
        !cachedInventory?.deviceId || cachedInventory.deviceId === targetDeviceId
          ? cachedInventory
          : null
      const currentItems =
        currentInventory?.marketplaceItems ?? catalog.getSnapshot().pluginMarketplaceState.items
      const nextMarketplaceItems = currentItems.map(candidate =>
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
      if (settled) {
        // Clear the operation marker before the shared inventory notifies views.
        operations.finishInstall(item.id)
      }
      commitPluginInventoryInstallation(
        marketplaceCacheKeyValue,
        targetDeviceId,
        plugin,
        nextMarketplaceItems
      )
      return { installed, deviceState }
    }

    request
      .then(({ plugin, targetDeviceId }) => {
        if (!isCurrent()) return
        const { installed, deviceState } = publishInstallation(plugin, targetDeviceId)
        notifyLocalPluginSkillsChanged()
        const authorizationPending =
          Boolean(plugin.status.localExecution) &&
          (plugin.spec.components.connectors ?? []).some(requiresInstallConnectorAuth)
        catalog.showNotice({
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
              : authorizationPending
                ? t(
                    'workbench.plugins_install_authorization_pending',
                    '{{name}} 已安装，可在插件详情中完成授权',
                    { name: item.displayName || item.name }
                  )
                : t('workbench.plugins_install_success_title', '{{name}} 已安装', {
                    name: item.displayName || item.name,
                    defaultValue: `${item.displayName || item.name} 已安装`,
                  }),
        })
        if (
          promptAfterInstall &&
          !authorizationPending &&
          queuePluginPromptTrial(installed.raw, promptAfterInstall, { openInNewChat: true })
        ) {
          navigateTo('/')
        }
      })
      .catch((error: unknown) => {
        installRequestAttempt?.fail('request')
        if (!isCurrent()) return
        if (error instanceof PluginInstallationSupersededError) return
        if (catalog.showPendingRecovery(error)) return
        const errorCode =
          error && (typeof error === 'object' || typeof error === 'function')
            ? Reflect.get(error, 'code')
            : undefined
        if (errorCode === 'PLUGIN_DEVICE_DISCONNECTED') {
          catalog.reportError(null)
          showDeviceDisconnectedNotice(item.id)
          return
        }
        if (errorCode === 'PLUGIN_DEVICE_ID_UNAVAILABLE') {
          catalog.reportError(null)
          showDeviceIdentityUnavailableNotice(item.id)
          return
        }
        const rawErrorMessage = getErrorMessage(
          error,
          t('workbench.plugins_install_failed', '安装失败，请稍后重试')
        )
        const errorMessage = humanizeMarketplaceInstallError(rawErrorMessage, t)
        console.error(
          '[Wework plugins] install failed',
          JSON.stringify({
            pluginId: item.id,
            pluginName: item.name,
            marketplaceId: localMarketplaceIdFromItem(item),
            installFromLocal,
            installPersonalSource,
            error: rawErrorMessage,
          })
        )
        const syncSettled =
          /failed to synchronize/i.test(rawErrorMessage) ||
          /PLUGIN_DEVICE_SYNC_FAILED/i.test(rawErrorMessage) ||
          error instanceof PluginDeviceReceiptError ||
          error instanceof LocalConnectorPluginSyncTimeoutError
        // Older backends 502 after Kind create; refresh so the row can show the
        // account install instead of leaving a permanent pink sync banner.
        if (syncSettled) {
          // Receipt polling already committed the account inventory. Another
          // immediate refresh would repeat the failed read and hide this notice.
          if (!(error instanceof PluginDeviceReceiptError)) {
            notifyLocalPluginSkillsChanged()
            catalog.refresh(false)
          }
          catalog.reportError(null)
          catalog.showNotice({
            id: `install-sync-${item.id}`,
            kind: 'error',
            message:
              error instanceof PluginDeviceReceiptError
                ? t(
                    'workbench.plugins_install_receipt_unconfirmed',
                    '{{name}} 已保存，暂未确认当前设备安装状态，请稍后刷新查看',
                    { name: item.displayName || item.name }
                  )
                : t(
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
        const lockedAbort = errorCode === 'MARKETPLACE_PLUGIN_LOCKED'
        if (!lockedAbort) {
          catalog.restoreMarketplaceItem(item)
        } else {
          catalog.reportError(null)
        }
        track('operation_failed', { operation: 'plugin_install' })
        catalog.showNotice({
          id: `install-error-${item.id}`,
          kind: 'error',
          message: errorMessage,
        })
      })
      .finally(() => {
        if (!isCurrent()) return
        operations.finishInstall(item.id)
      })
  }

  return {
    pendingInstall,
    setPendingInstall,
    pendingPluginUpdate,
    setPendingPluginUpdate,
    connectionNamesRequiredForInstall,
    installMarketplacePlugin,
    executeMarketplaceInstall,
  }
}
