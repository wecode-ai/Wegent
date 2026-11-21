import { trackPluginEvent as track } from '@/telemetry/businessEvents'

import { getErrorMessage } from '@/lib/error-message'

import {
  beginPluginDeviceSync,
  markPluginDeviceAutoSyncAttempted,
  markPluginDeviceAutoSyncSettled,
} from '@/features/plugins/pluginDeviceAutoSync'

import {
  marketplaceItemNeedsPluginAutoUpdate,
  pendingPluginSyncTargets,
  runPluginAutoUpdate,
} from '@/features/plugins/pluginAutoUpdate'

import { isCloudManagedInstalledPlugin } from '../installedPluginMerge'

import type { PluginCatalogContext } from './pluginCatalogState'

export function updatePluginCatalogDevice(ctx: PluginCatalogContext) {
  const owner = ctx.epoch
  const scopeIsCurrent = () => owner !== null && ctx.epoch === owner
  const requireScope = () => {
    if (!scopeIsCurrent()) throw new DOMException('Plugin scope changed', 'AbortError')
  }
  if (!ctx.input.cloudMarketplaceAvailable || !ctx.input.cloudToken || !ctx.state.currentDeviceId)
    return
  if (!ctx.state.inventoryComplete) return
  if (ctx.input.pluginMutationInFlight) return
  // Manual reconciliation owns the complete device snapshot and its ACK.
  if (ctx.input.isReconcilingPlugins || ctx.ledger.manualReconciliationTick?.accountKey === ctx.key)
    return
  if (!ctx.input.deviceCloudConnected) return
  if (ctx.state.localInstalledStateReadyKey !== ctx.key) return
  if (ctx.catalog.isLoading) return
  const autoUpdateCandidateReleaseKeys = ctx.catalog.items.flatMap(item => {
    if (!marketplaceItemNeedsPluginAutoUpdate(item)) return []
    if (item.installedPluginId === null || item.installedPluginId === undefined) return []
    const installed = ctx.state.installedPlugins.find(
      plugin => String(plugin.id) === String(item.installedPluginId)
    )
    if (
      !installed ||
      !isCloudManagedInstalledPlugin(installed.raw) ||
      installed.raw.spec.updatePolicy !== 'auto'
    ) {
      return []
    }
    const targetReleaseId = item.latestReleaseId ?? item.currentDeviceInstallation?.desiredReleaseId
    return targetReleaseId === null || targetReleaseId === undefined
      ? []
      : [`${item.installedPluginId}:${targetReleaseId}`]
  })
  if (autoUpdateCandidateReleaseKeys.length === 0) return
  const releaseKey = autoUpdateCandidateReleaseKeys.sort().join(',')
  const attemptKey = `${ctx.key}:${ctx.state.currentDeviceId}:${releaseKey}`
  if (ctx.ledger.autoUpdateAttemptKeys.has(attemptKey)) return
  const finishDeviceSync = beginPluginDeviceSync(ctx.state.currentDeviceId, 'auto-update')
  if (!finishDeviceSync) return
  ctx.publish({ deviceAutoSyncSettled: false })
  ctx.ledger.autoUpdateAttemptKeys.add(attemptKey)
  const deviceId = ctx.state.currentDeviceId
  void runPluginAutoUpdate({
    updateBatch: () => {
      requireScope()
      return ctx.input.pluginApi.autoUpdateInstalledPlugins()
    },
    syncPlugin: installedPluginId => {
      requireScope()
      return ctx.input.pluginApi.syncInstalledPluginToDevice(installedPluginId, deviceId)
    },
    pendingInstalls: pendingPluginSyncTargets(ctx.catalog.items),
    onProgress: ({ processedCount, remainingCount }) => {
      if (!scopeIsCurrent() || ctx.state.currentDeviceId !== deviceId) return
      ctx.publish({
        pluginOperationNotice: {
          id: `plugin-auto-update-${deviceId}`,
          kind: 'authorization',
          message: ctx.input.t(
            'workbench.plugins_auto_update_progress',
            '正在自动更新插件：已处理 {{updated}} 个，剩余 {{remaining}} 个',
            { updated: processedCount, remaining: remainingCount }
          ),
        },
      })
    },
  })
    .then(result => {
      if (!scopeIsCurrent() || ctx.state.currentDeviceId !== deviceId) return
      if (result.failedCount > 0) {
        const stageLabels: Record<string, string> = {
          local_state: ctx.input.t(
            'workbench.plugins_auto_update_stage_local_state',
            '读取本地插件状态'
          ),
          download: ctx.input.t('workbench.plugins_auto_update_stage_download', '下载插件包'),
          checksum: ctx.input.t('workbench.plugins_auto_update_stage_checksum', '校验插件包'),
          prepare: ctx.input.t('workbench.plugins_auto_update_stage_prepare', '准备本地插件目录'),
          extract: ctx.input.t('workbench.plugins_auto_update_stage_extract', '解压插件包'),
          codex_config: ctx.input.t(
            'workbench.plugins_auto_update_stage_codex_config',
            '写入 Codex 配置'
          ),
          runtime_metadata: ctx.input.t(
            'workbench.plugins_auto_update_stage_runtime_metadata',
            '写入插件运行时配置'
          ),
          package: ctx.input.t('workbench.plugins_auto_update_stage_package', '检查本地插件包'),
        }
        const error = result.failures
          .map(failure => {
            const stage = failure.stage ? ` (${stageLabels[failure.stage] || failure.stage})` : ''
            return `${failure.pluginName}${stage}: ${failure.message}`
          })
          .join('; ')
        ctx.publish({
          pluginOperationNotice: {
            id: `plugin-auto-update-error-${deviceId}`,
            kind: 'error',
            message:
              result.updatedCount > 0
                ? ctx.input.t(
                    'workbench.plugins_auto_update_partial',
                    '已自动更新 {{updated}} 个插件，{{failed}} 个失败：{{error}}',
                    {
                      updated: result.updatedCount,
                      failed: result.failedCount,
                      error,
                    }
                  )
                : ctx.input.t(
                    'workbench.plugins_auto_update_failed',
                    '插件自动更新失败，当前设备继续使用原版本：{{error}}',
                    { error }
                  ),
          },
        })
        track('operation_failed', { operation: 'plugin_auto_update' })
      } else if (result.updatedCount > 0) {
        ctx.publish({
          pluginOperationNotice: {
            id: `plugin-auto-update-complete-${deviceId}`,
            kind: 'success',
            message: ctx.input.t(
              'workbench.plugins_auto_update_complete',
              '已自动更新 {{count}} 个插件',
              {
                count: result.updatedCount,
              }
            ),
          },
        })
      } else {
        ctx.publish({
          pluginOperationNotice: (current =>
            current?.id === `plugin-auto-update-${deviceId}` ? null : current)(
            ctx.state.pluginOperationNotice
          ),
        })
      }
      markPluginDeviceAutoSyncAttempted(deviceId)
      markPluginDeviceAutoSyncSettled(deviceId)
      ctx.publish({ deviceAutoSyncSettled: true })
    })
    .catch(error => {
      if (!scopeIsCurrent() || ctx.state.currentDeviceId !== deviceId) return
      markPluginDeviceAutoSyncAttempted(deviceId)
      markPluginDeviceAutoSyncSettled(deviceId)
      ctx.publish({ deviceAutoSyncSettled: true })
      ctx.publish({
        pluginOperationNotice: {
          id: `plugin-auto-update-error-${deviceId}`,
          kind: 'error',
          message: ctx.input.t(
            'workbench.plugins_auto_update_failed',
            '插件自动更新失败，当前设备继续使用原版本：{{error}}',
            { error: getErrorMessage(error, 'Unknown error') }
          ),
        },
      })
      track('operation_failed', { operation: 'plugin_auto_update' })
    })
    .finally(() => {
      finishDeviceSync()
      if (scopeIsCurrent() && ctx.state.currentDeviceId === deviceId) {
        ctx.publish({
          marketplaceRefreshTick: (previous => previous + 1)(ctx.state.marketplaceRefreshTick),
        })
      }
    })
}
