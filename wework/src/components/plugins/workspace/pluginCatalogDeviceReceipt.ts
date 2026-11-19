import {
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'

import { pluginInventoryReadIsCurrent } from '@/features/plugins/pluginInventory'

import {
  beginPluginDeviceSync,
  collectPluginDeviceStatusReports,
  hasAttemptedPluginDeviceAutoSync,
  hasAttemptedPluginDeviceStatusReport,
  hasSettledPluginDeviceAutoSync,
  marketplaceNeedsDeviceSync,
  markPluginDeviceAutoSyncAttempted,
  markPluginDeviceAutoSyncSettled,
  markPluginDeviceStatusReportAttempted,
  withAcknowledgedDeviceInstallations,
  withAcknowledgedMarketplaceDeviceState,
  withOptimisticDevicePending,
} from '@/features/plugins/pluginDeviceAutoSync'

import { hasLocalCodexMaterialization } from '../installedPluginMerge'

import { mergeInstalledPlugins } from '../installedPluginMerge'

import { toInstalledPluginItem } from '../workspace/marketplaceWorkspaceHelpers'

import {
  readPersonalMarketplaceForCloudRefresh,
  mergeCloudMarketplaceRefresh,
} from './pluginCatalogRefresh'

import type { PluginCatalogContext } from './pluginCatalogState'

const DEVICE_STATUS_REPORT_MAX_RETRIES = 3
const DEVICE_STATUS_REPORT_RETRY_BASE_MS = 1000
export function reconcilePluginCatalogDeviceReceipt(ctx: PluginCatalogContext) {
  if (!ctx.input.cloudMarketplaceAvailable || !ctx.input.cloudToken || !ctx.state.currentDeviceId)
    return
  if (!ctx.state.inventoryComplete) return
  if (ctx.state.localInstalledStateReadyKey !== ctx.key) return
  if (ctx.catalog.isLoading) return
  // The foreground mutation owns its ACK; pending membership is not a repair gap yet.
  if (ctx.input.pluginMutationInFlight) return
  if (ctx.ledger.deviceStatusReportRetryTimer !== null) return
  if (ctx.input.isReconcilingPlugins || ctx.ledger.manualReconciliationTick?.accountKey === ctx.key)
    return
  const deviceId = ctx.state.currentDeviceId
  const lifetime = ctx.epoch
  const accountLifetime = ctx.epoch
  const inventoryAtStart = getPluginMarketplaceCache(ctx.key)
  const syncScopeIsCurrent = () =>
    accountLifetime !== null &&
    ctx.epoch === accountLifetime &&
    lifetime !== null &&
    ctx.epoch === lifetime &&
    ctx.key === ctx.key &&
    ctx.state.currentDeviceId === deviceId
  const syncIsCurrent = () =>
    syncScopeIsCurrent() && pluginInventoryReadIsCurrent(ctx.key, inventoryAtStart)
  const reports = collectPluginDeviceStatusReports(
    ctx.state.installedPlugins.map(plugin => plugin.raw),
    ctx.catalog.items,
    deviceId
  )
  const reportIds = reports.map(report => report.installedPluginId)
  const needsPackageSync = marketplaceNeedsDeviceSync(ctx.catalog.items)
  if (reportIds.length === 0 && !needsPackageSync) {
    if (
      hasAttemptedPluginDeviceStatusReport(deviceId) &&
      !hasSettledPluginDeviceAutoSync(deviceId)
    ) {
      markPluginDeviceAutoSyncSettled(deviceId)
      ctx.publish({ deviceAutoSyncSettled: true })
    }
    return
  }
  const refreshCatalog = async () => {
    if (!syncIsCurrent()) return
    const [cloud, installed, personalRead] = await Promise.all([
      ctx.input.pluginApi.listMarketplacePlugins({
        deviceId,
      }),
      ctx.input.pluginApi.listInstalledPlugins(deviceId),
      readPersonalMarketplaceForCloudRefresh(),
    ])
    if (!syncIsCurrent()) return
    const nextInstalled = mergeInstalledPlugins(
      installed.items,
      ctx.state.installedPlugins.map(plugin => plugin.raw).filter(hasLocalCodexMaterialization),
      deviceId,
      true
    ).map(toInstalledPluginItem)
    const nextItems = mergeCloudMarketplaceRefresh(
      ctx.catalog.items,
      cloud.items,
      nextInstalled.map(plugin => plugin.raw),
      personalRead
    )
    const cached = getPluginMarketplaceCache(ctx.key)
    if (cached) {
      setPluginMarketplaceCache({
        ...cached,
        marketplaceItems: nextItems,
        installedPlugins: nextInstalled.map(plugin => plugin.raw),
        deviceId,
        fetchedAt: Date.now(),
      })
    }
  }
  if (reports.length > 0 && !hasAttemptedPluginDeviceStatusReport(deviceId, reports)) {
    const finishDeviceSync = beginPluginDeviceSync(deviceId, 'status-report')
    if (!finishDeviceSync) return
    void ctx.input.pluginApi
      .reportInstalledPluginsOnDevice(deviceId, reports)
      .then(response => {
        if (!syncIsCurrent()) return
        markPluginDeviceStatusReportAttempted(deviceId, reports)
        ctx.ledger.deviceStatusReportFailureCounts.delete(deviceId)
        if (ctx.ledger.deviceStatusReportRetryTimer !== null) {
          window.clearTimeout(ctx.ledger.deviceStatusReportRetryTimer)
          ctx.ledger.deviceStatusReportRetryTimer = null
        }
        const acknowledgedIds = response.acknowledgedInstalledPluginIds
        const cached = getPluginMarketplaceCache(ctx.key)
        if (acknowledgedIds.length > 0 && cached) {
          setPluginMarketplaceCache({
            ...cached,
            installedPlugins: withAcknowledgedDeviceInstallations(
              cached.installedPlugins,
              deviceId,
              acknowledgedIds
            ),
            marketplaceItems: withAcknowledgedMarketplaceDeviceState(
              cached.marketplaceItems,
              deviceId,
              acknowledgedIds
            ),
          })
        }
        return refreshCatalog().catch(() => undefined)
      })
      .catch(() => {
        if (!syncScopeIsCurrent()) return
        const failureCount = (ctx.ledger.deviceStatusReportFailureCounts.get(deviceId) ?? 0) + 1
        ctx.ledger.deviceStatusReportFailureCounts.set(deviceId, failureCount)
        if (
          failureCount <= DEVICE_STATUS_REPORT_MAX_RETRIES &&
          ctx.ledger.deviceStatusReportRetryTimer === null
        ) {
          const delay = DEVICE_STATUS_REPORT_RETRY_BASE_MS * 2 ** (failureCount - 1)
          ctx.ledger.deviceStatusReportRetryTimer = window.setTimeout(() => {
            ctx.ledger.deviceStatusReportRetryTimer = null
            if (syncScopeIsCurrent()) {
              ctx.publish({
                marketplaceRefreshTick: (previous => previous + 1)(
                  ctx.state.marketplaceRefreshTick
                ),
              })
            }
          }, delay)
        }
      })
      .finally(finishDeviceSync)
    return
  }
  if (!needsPackageSync) return
  if (!ctx.input.deviceCloudConnected) {
    ctx.publish({ deviceAutoSyncSettled: true })
    return
  }
  if (hasAttemptedPluginDeviceAutoSync(ctx.state.currentDeviceId)) return
  const finishDeviceSync = beginPluginDeviceSync(ctx.state.currentDeviceId, 'auto-sync')
  if (!finishDeviceSync) return
  ctx.publish({ deviceAutoSyncSettled: false })
  markPluginDeviceAutoSyncAttempted(ctx.state.currentDeviceId)
  // Only show syncing after live membership confirms a real device gap.
  ctx.publish({
    marketplaceCatalogState: (previous => ({
      ...previous,
      items: withOptimisticDevicePending(previous.items, deviceId),
    }))(ctx.state.marketplaceCatalogState),
  })
  // Do not cancel on items/deps churn (optimistic pending updates re-enter this
  // effect). Ignore results after unmount or an account/device scope change.
  void ctx.input.pluginApi
    .syncInstalledPluginsToDevice(deviceId)
    .catch(() => undefined)
    .then(refreshCatalog)
    .then(() => {
      if (syncScopeIsCurrent()) {
        markPluginDeviceAutoSyncSettled(deviceId)
        ctx.publish({ deviceAutoSyncSettled: true })
      }
    })
    .catch(() => {
      if (syncScopeIsCurrent()) {
        markPluginDeviceAutoSyncSettled(deviceId)
        ctx.publish({ deviceAutoSyncSettled: true })
      }
    })
    .finally(finishDeviceSync)
}
