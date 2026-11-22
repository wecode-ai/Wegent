import { beginOperation } from '@/telemetry/operationBus'
import {
  beginPluginSettingsRequest,
  ExpiredPluginSettingsRequest,
} from '@/features/plugins/pluginSettingsRequest'
import { trackPluginEvent as track } from '@/telemetry/businessEvents'
import {
  installedPluginTelemetryIdentity,
  pluginTelemetryIdentityFromParts,
} from '@/telemetry/pluginIdentity'
import { getErrorMessage } from '@/lib/error-message'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import {
  capturePluginMarketplaceScope,
  removePluginMarketplaceInstallation,
} from '@/features/plugins/pluginMarketplaceCache'
import { updatePluginInventoryInstallation } from '@/features/plugins/pluginInventory'
import { acquirePluginDeviceSync } from '@/features/plugins/pluginDeviceAutoSync'
import type { InstalledPlugin } from '@/types/api'
import { type InstalledPluginItem } from '../PluginManagementRows'
import {
  isCloudManagedInstalledPlugin,
  linkedCloudPluginId,
  linkedCloudInstalledPluginId,
} from '../installedPluginMerge'
import { humanizeMarketplaceUninstallError } from '../marketplaceInstallError'
import {
  pluginUninstallWarningDetails,
  uninstallAccountPlugin,
  uninstallPluginIdentities,
} from '../pluginUninstall'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from '../pluginDistribution'
import { isCodexCatalogItem } from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginWorkspaceServices } from './pluginWorkspaceTypes'
import { ownedPersonalPluginSourceKey } from './personalPluginCloudInstall'

export function usePluginInstalledOperations({
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
}: Pick<
  PluginWorkspaceServices,
  | 'installedPlugins'
  | 'catalog'
  | 'marketplaceCacheKeyValue'
  | 'knownExecutorDeviceId'
  | 'localPluginApi'
  | 'pluginApi'
  | 'currentDeviceId'
  | 'operations'
  | 't'
  | 'reconciliationBlocksActions'
  | 'setSelectedPluginId'
  | 'connectorHealth'
>) {
  const capturePluginScope = catalog.captureScope
  const togglePluginComponent = (id: string | number, componentKey: string, enabled: boolean) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return

    const deviceId = catalog.getSnapshot().currentDeviceId
    const scopeIsCurrent = capturePluginMarketplaceScope(marketplaceCacheKeyValue, deviceId)
    const request = { componentStates: { [componentKey]: enabled } }
    const operation = beginPluginSettingsRequest(
      JSON.stringify([marketplaceCacheKeyValue, deviceId]),
      id,
      request,
      () =>
        scopeIsCurrent() &&
        (!knownExecutorDeviceId || getKnownLocalExecutorDeviceId() === knownExecutorDeviceId)
    )

    const previousStates = plugin.raw.spec.componentStates || {}
    catalog.previewComponentState(id, componentKey, enabled)
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
        if (!operation.isCurrent()) return
        updatePluginInventoryInstallation(
          marketplaceCacheKeyValue,
          id,
          updated,
          operation.currentUpdate()
        )
        track('plugin_enabled_changed', {
          enabled,
          scope: 'component',
          source: isCloudManagedInstalledPlugin(plugin.raw) ? 'cloud' : 'local',
          ...installedPluginTelemetryIdentity(plugin.raw),
        })
      })
      .catch(error => {
        if (!operation.isCurrent() || error instanceof ExpiredPluginSettingsRequest) return
        catalog.restoreComponentState(id, previousStates, componentKey)
        track('operation_failed', { operation: 'plugin_toggle' })
      })
      .finally(operation.finish)
  }

  const changePluginAutoUpdatePolicy = (plugin: InstalledPluginItem, enabled: boolean) => {
    if (!isCloudManagedInstalledPlugin(plugin.raw)) return
    const isCurrent = capturePluginScope()
    const attempt = beginOperation('plugin.update_policy')
    const updatePolicy = enabled ? 'auto' : 'manual'
    const pluginId = plugin.id
    operations.beginPolicy(pluginId)
    catalog.reportError(null)

    let finishDeviceSync: (() => void) | undefined
    const deviceLease = currentDeviceId
      ? acquirePluginDeviceSync(currentDeviceId, undefined, 'policy')
      : Promise.resolve(() => {})
    void deviceLease
      .then(finish => {
        finishDeviceSync = finish
        if (!isCurrent()) throw new DOMException('Plugin scope changed', 'AbortError')
        return pluginApi.updateInstalledPlugin(pluginId, { updatePolicy }, currentDeviceId)
      })
      .then(updated => {
        if (!isCurrent()) return attempt.cancel()
        updatePluginInventoryInstallation(marketplaceCacheKeyValue, pluginId, updated, {
          updatePolicy,
        })
        attempt.succeed()
      })
      .catch(error => {
        if (!isCurrent()) return attempt.cancel()
        attempt.fail('request')
        const errorMessage = getErrorMessage(error, 'Unknown error')
        catalog.reportError(
          t('workbench.plugins_update_policy_failed', {
            error: errorMessage,
            defaultValue: `无法保存插件更新设置：${errorMessage}`,
          })
        )
      })
      .finally(() => {
        finishDeviceSync?.()
        if (!isCurrent()) return
        operations.finishPolicy(pluginId)
      })
  }

  const uninstallInstalledPlugin = (id: string | number, pluginName: string) => {
    const isCurrent = capturePluginScope()
    if (!isCurrent()) return
    if (reconciliationBlocksActions) {
      catalog.showNotice({
        id: 'plugin-reconciliation-busy',
        kind: 'error',
        message: t('workbench.plugins_reconciliation_busy', '正在检查安装状态，请完成后再操作'),
      })
      return
    }
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
    operations.beginUninstall(id, catalogItem?.id)
    const markUninstalledLocally = () => {
      const marketplaceId = plugin
        ? installedPluginMarketplaceId(plugin.raw)
        : catalogItem && marketplaceItemMarketplaceId(catalogItem)
      removePluginMarketplaceInstallation(marketplaceCacheKeyValue, {
        installedIds: [id, plugin?.id, plugin && linkedCloudInstalledPluginId(plugin.raw)],
        marketplaceItemIds: [
          catalogItem?.id,
          plugin?.raw.spec.pluginId,
          plugin && linkedCloudPluginId(plugin.raw),
        ],
        marketplaceId,
        // Without a marketplace, only exact IDs are safe removal identities.
        pluginKeys: marketplaceId ? [pluginName, plugin?.raw.spec.source.pluginKey] : [],
      })
      setSelectedPluginId(current => (String(current) === String(id) ? null : current))
      connectorHealth.clear()
      notifyLocalPluginSkillsChanged()
      track('plugin_uninstalled', {
        source:
          (plugin && isCloudManagedInstalledPlugin(plugin.raw)) ||
          (!plugin && catalogItem && !isCodexCatalogItem(catalogItem))
            ? 'cloud'
            : 'local',
        ...(plugin
          ? installedPluginTelemetryIdentity(plugin.raw)
          : pluginTelemetryIdentityFromParts({ marketplace: 'unknown', pluginKey: pluginName })),
      })
    }

    const noticeUninstallError = (id: string | number, error: unknown) => {
      if (catalog.showPendingRecovery(error)) return
      const rawErrorMessage = getErrorMessage(
        error,
        t('workbench.plugins_uninstall_failed', '卸载失败，请稍后重试')
      )
      const errorMessage = humanizeMarketplaceUninstallError(rawErrorMessage, t)
      console.error('[Wework plugins] uninstall plugin failed', {
        pluginId: id,
        error: rawErrorMessage,
      })
      catalog.showNotice({
        id: `uninstall-error-${id}`,
        kind: 'error',
        message: errorMessage,
      })
    }

    const uninstallOperations = {
      personalSourceKey: ownedPersonalPluginSourceKey(catalogItem),
      readLocalInstalled: () =>
        localPluginApi.listInstalledPlugins({ refresh: true, requireComplete: true }),
      readCloudInstalled: () => pluginApi.readInstalledPluginsForUninstall(),
      isCurrent,
      logoutLocal: (resolvedPlugin: InstalledPlugin) =>
        logoutLocalConnectorsForPlugin(resolvedPlugin),
      uninstallCloud: (pluginId: string | number, deviceId?: string) =>
        pluginApi.uninstallInstalledPlugin(
          pluginId,
          deviceId,
          catalog.reportLocalProgress(`uninstall-progress-${id}`, isCurrent)
        ),
      uninstallLocal: (pluginId: string | number) =>
        localPluginApi.uninstallInstalledPlugin(pluginId),
    }
    const request = plugin
      ? uninstallPluginIdentities(
          plugin.raw,
          plugin.id,
          currentDeviceId || undefined,
          uninstallOperations
        )
      : catalogItem && isCodexCatalogItem(catalogItem)
        ? uninstallPluginIdentities(null, id, currentDeviceId || undefined, uninstallOperations)
        : catalogItem
          ? uninstallAccountPlugin(
              catalogItem.id,
              currentDeviceId || undefined,
              uninstallOperations
            ).then(() => ({ warnings: [] }))
          : Promise.reject(new Error('PLUGIN_UNINSTALL_PREFLIGHT_FAILED'))
    void request
      .then(outcome => {
        if (!isCurrent()) return
        markUninstalledLocally()
        const warningDetails = pluginUninstallWarningDetails(outcome)
        catalog.showNotice({
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
        if (!isCurrent()) return
        track('operation_failed', { operation: 'plugin_uninstall' })
        noticeUninstallError(id, error)
      })
      .finally(() => {
        if (!isCurrent()) return
        operations.finishUninstall(id, catalogItem?.id)
      })
  }

  return { togglePluginComponent, changePluginAutoUpdatePolicy, uninstallInstalledPlugin }
}
