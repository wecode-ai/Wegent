import type { TFunction } from 'i18next'
import type { SetStateAction } from 'react'
import type { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { createLocalDevicePluginApi } from '@/features/plugins/pluginDeviceApi'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import {
  beginPluginSettingsRequest,
  ExpiredPluginSettingsRequest,
  type PluginSettingsUpdate,
} from '@/features/plugins/pluginSettingsRequest'
import {
  updatePluginInventoryInstallation,
  hasLoadedPluginInventory,
  refreshInstalledPluginInventory,
  commitPluginInventoryInstallation,
} from '@/features/plugins/pluginInventory'
import {
  capturePluginMarketplaceScope,
  getPluginMarketplaceCache,
  getPluginMarketplaceAccountEpoch,
  removePluginMarketplaceInstallation,
  subscribePluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import { getErrorMessage } from '@/lib/error-message'
import { trackPluginEvent as track } from '@/telemetry/businessEvents'
import { installedPluginTelemetryIdentity } from '@/telemetry/pluginIdentity'
import { observeOperation } from '@/telemetry/observeOperation'
import { toInstalledPluginItem } from './installedPluginPresentation'
import type { InstalledPluginItem } from './PluginManagementRows'
import type { PluginOperationNoticeState } from './PluginOperationNotice'
import {
  isCloudManagedInstalledPlugin,
  linkedCloudInstalledPluginId,
  linkedCloudPluginId,
} from './installedPluginMerge'
import {
  pluginUninstallScope,
  pluginUninstallWarningDetails,
  uninstallPluginIdentities,
  type PluginUninstallScope,
} from './pluginUninstall'
import { humanizeMarketplaceUninstallError } from './marketplaceInstallError'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from './pluginDistribution'
import { findMarketplaceItemForInstalled } from './findMarketplaceItemForInstalled'
import { ownedPersonalPluginSourceKey } from './workspace/personalPluginInstallSource'

export type PluginManagementTab = 'codex' | 'core-dsh'
interface SourceOptions {
  cacheKey: string
  knownDeviceId: string
  localPluginApi: ReturnType<typeof createLocalCodexPluginApi>
  cloudPluginApi: ReturnType<typeof createLocalDevicePluginApi>
}
interface PluginManagementState {
  selectedPluginId: string | number | null
  pendingUninstall: { id: string | number; name: string; scope: PluginUninstallScope } | null
  uninstallingPluginIds: Set<string | number>
  pluginOperationNotice: PluginOperationNoticeState | null
  activeTab: PluginManagementTab
}
interface SettingsOverlay {
  token: symbol
  id: string
  rollback?: boolean
  enabled?: boolean
  componentKey?: string
  value?: boolean
}
const EMPTY_MARKETPLACE: PluginMarketplaceItem[] = []

/** One Backend/account/device inventory owns selection and pending management operations. */
export function createPluginManagementSource({
  cacheKey,
  knownDeviceId,
  localPluginApi,
  cloudPluginApi,
}: SourceOptions) {
  const epoch = getPluginMarketplaceAccountEpoch()
  const cached = getPluginMarketplaceCache(cacheKey)
  let inventory = knownDeviceId && cached?.deviceId !== knownDeviceId ? null : cached
  let loading = !hasLoadedPluginInventory(inventory)
  let state: PluginManagementState = {
    selectedPluginId: null,
    pendingUninstall: null,
    uninstallingPluginIds: new Set(),
    pluginOperationNotice: null,
    activeTab: 'codex',
  }
  let projection:
    | (PluginManagementState & {
        installedPlugins: InstalledPluginItem[]
        marketplaceItems: PluginMarketplaceItem[]
        currentDeviceId: string
        isLoadingPlugins: boolean
      })
    | null = null
  const overlays = new Map<string, SettingsOverlay>()
  const listeners = new Set<() => void>()
  let stopInventory: (() => void) | null = null
  let generation = 0
  let observationGeneration = 0
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let pendingUninstallOwner: (() => boolean) | null = null
  let translate: TFunction<'common'> | null = null
  const observed = () => listeners.size > 0
  const profileIsCurrent = () =>
    getPluginMarketplaceAccountEpoch() === epoch &&
    (!knownDeviceId || getKnownLocalExecutorDeviceId() === knownDeviceId)
  const translator = () => {
    if (!translate) throw new Error('Plugin management is not observed')
    return translate
  }
  let presentedBase: InstalledPlugin[] | null = null
  let presentedInstalled: InstalledPluginItem[] = []
  let overlayRevision = 0
  let presentedRevision = -1
  const getSnapshot = () => {
    if (projection) return projection
    const rawInstalled = inventory?.installedPlugins ?? null
    if (rawInstalled !== presentedBase || overlayRevision !== presentedRevision) {
      presentedBase = rawInstalled
      presentedRevision = overlayRevision
      presentedInstalled = (rawInstalled ?? []).map(raw => {
        const baseItem = toInstalledPluginItem(raw)
        let plugin = raw
        for (const overlay of overlays.values()) {
          if (overlay.id !== String(baseItem.id)) continue
          if (overlay.enabled !== undefined)
            plugin = { ...plugin, spec: { ...plugin.spec, enabled: overlay.enabled } }
          if (overlay.componentKey !== undefined) {
            const componentStates = { ...plugin.spec.componentStates }
            if (overlay.value === undefined) delete componentStates[overlay.componentKey]
            else componentStates[overlay.componentKey] = overlay.value
            plugin = { ...plugin, spec: { ...plugin.spec, componentStates } }
          }
        }
        return plugin === raw ? baseItem : toInstalledPluginItem(plugin)
      })
    }
    const installedPlugins = presentedInstalled
    projection = {
      ...state,
      installedPlugins,
      marketplaceItems: inventory?.marketplaceItems ?? EMPTY_MARKETPLACE,
      currentDeviceId: knownDeviceId || inventory?.deviceId || '',
      isLoadingPlugins: loading,
    }
    return projection
  }
  const publish = () => {
    projection = null
    for (const listener of listeners) listener()
  }
  const set = <K extends keyof PluginManagementState>(
    key: K,
    value: SetStateAction<PluginManagementState[K]>
  ) => {
    if (!observed()) return
    const next = typeof value === 'function' ? value(state[key]) : value
    if (Object.is(next, state[key])) return
    state = { ...state, [key]: next }
    if (key === 'pluginOperationNotice') scheduleNotice()
    publish()
  }
  function scheduleNotice() {
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    noticeTimer = null
    const notice = state.pluginOperationNotice
    if (observed() && notice?.kind === 'success')
      noticeTimer = setTimeout(() => {
        noticeTimer = null
        set('pluginOperationNotice', current => (current?.id === notice.id ? null : current))
      }, 4000)
  }
  function currentView() {
    const version = generation
    const scope = capturePluginMarketplaceScope(cacheKey, getSnapshot().currentDeviceId)
    return () => observed() && version === generation && profileIsCurrent() && scope()
  }
  async function refresh() {
    const version = generation
    const isCurrent = () => observed() && version === generation && profileIsCurrent()
    try {
      await refreshInstalledPluginInventory({
        cacheKey,
        deviceId: knownDeviceId,
        readLocal: () => localPluginApi.listInstalledPlugins(),
        readCloud: deviceId => cloudPluginApi.listInstalledPlugins(deviceId),
        isCurrent,
      })
    } catch (error) {
      if (isCurrent())
        set('pluginOperationNotice', {
          id: 'inventory-load-failed',
          kind: 'error',
          message: getErrorMessage(
            error,
            translator()('workbench.plugins_load_failed', '加载插件失败')
          ),
        })
    } finally {
      if (isCurrent()) {
        loading = false
        publish()
      }
    }
  }
  function updateSettings(id: string | number, enabled: boolean, componentKey?: string) {
    if (!observed() || !profileIsCurrent()) return
    const snapshot = getSnapshot()
    const plugin = snapshot.installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    const request: PluginSettingsUpdate =
      componentKey === undefined ? { enabled } : { componentStates: { [componentKey]: enabled } }
    const scope = capturePluginMarketplaceScope(cacheKey, snapshot.currentDeviceId)
    const operation = beginPluginSettingsRequest(
      JSON.stringify([cacheKey, snapshot.currentDeviceId]),
      id,
      request,
      () => profileIsCurrent() && scope()
    )
    if (!operation.isCurrent()) {
      operation.finish()
      return
    }
    const token = Symbol('plugin-management-settings')
    const field = JSON.stringify([String(id), componentKey ?? null])
    const overlay: SettingsOverlay =
      componentKey === undefined
        ? { token, id: String(id), enabled }
        : { token, id: String(id), componentKey, value: enabled }
    overlays.set(field, overlay)
    overlayRevision += 1
    publish()
    const pending = isCloudManagedInstalledPlugin(plugin.raw)
      ? cloudPluginApi.updateInstalledPlugin(id, request, snapshot.currentDeviceId || undefined)
      : localPluginApi.updateInstalledPlugin(id, request)
    void pending
      .then(updated => {
        if (!operation.isCurrent()) return
        updatePluginInventoryInstallation(cacheKey, id, updated, operation.currentUpdate())
        if (componentKey === undefined) notifyLocalPluginSkillsChanged()
        track('plugin_enabled_changed', {
          enabled,
          scope: componentKey === undefined ? 'plugin' : 'component',
          source: isCloudManagedInstalledPlugin(plugin.raw) ? 'cloud' : 'local',
          ...installedPluginTelemetryIdentity(plugin.raw),
        })
      })
      .catch(error => {
        if (!operation.isCurrent() || error instanceof ExpiredPluginSettingsRequest) return
        if (overlays.get(field)?.token === token) {
          // Restore the field seen before this action; a later inventory event supplies canonical state.
          overlays.set(
            field,
            componentKey === undefined
              ? { token, id: String(id), rollback: true, enabled: plugin.enabled }
              : {
                  token,
                  id: String(id),
                  rollback: true,
                  componentKey,
                  value: plugin.raw.spec.componentStates?.[componentKey],
                }
          )
          overlayRevision += 1
          publish()
        }
        track('operation_failed', { operation: 'plugin_toggle' })
      })
      .finally(() => {
        if (overlays.get(field)?.token === token && !overlays.get(field)?.rollback) {
          overlays.delete(field)
          overlayRevision += 1
          publish()
        }
        operation.finish()
      })
  }
  function uninstallInstalledPlugin(id: string | number, pluginName: string) {
    const isCurrent = currentView()
    if (!isCurrent()) return
    const snapshot = getSnapshot()
    const plugin = snapshot.installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) {
      set('uninstallingPluginIds', previous => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      set('pluginOperationNotice', {
        id: `uninstall-error-${id}`,
        kind: 'error',
        message: translator()('workbench.plugins_uninstall_failed', '卸载失败，请稍后重试'),
      })
      return
    }
    const marketplaceItem = findMarketplaceItemForInstalled(plugin, snapshot.marketplaceItems)
    void uninstallPluginIdentities(plugin.raw, id, snapshot.currentDeviceId || undefined, {
      personalSourceKey: ownedPersonalPluginSourceKey(marketplaceItem),
      readLocalInstalled: () =>
        localPluginApi.listInstalledPlugins({ refresh: true, requireComplete: true }),
      readCloudInstalled: () => cloudPluginApi.readInstalledPluginsForUninstall(),
      isCurrent,
      logoutLocal: () => logoutLocalConnectorsForPlugin(plugin.raw),
      uninstallCloud: (pluginId, deviceId) =>
        cloudPluginApi.uninstallInstalledPlugin(pluginId, deviceId),
      uninstallLocal: pluginId => localPluginApi.uninstallInstalledPlugin(pluginId),
    })
      .then(outcome => {
        if (!isCurrent()) return
        removePluginMarketplaceInstallation(cacheKey, {
          installedIds: [id, plugin.id, linkedCloudInstalledPluginId(plugin.raw)],
          marketplaceItemIds: [
            marketplaceItem?.id,
            marketplaceItem?.remotePluginId,
            plugin.raw.spec.pluginId,
            linkedCloudPluginId(plugin.raw),
          ],
          marketplaceId:
            (marketplaceItem && marketplaceItemMarketplaceId(marketplaceItem)) ||
            installedPluginMarketplaceId(plugin.raw),
          pluginKeys: [
            plugin.raw.spec.source.pluginKey,
            typeof plugin.raw.metadata.name === 'string' ? plugin.raw.metadata.name : null,
            pluginName,
          ],
        })
        set('selectedPluginId', current => (String(current) === String(id) ? null : current))
        notifyLocalPluginSkillsChanged()
        const warningDetails = pluginUninstallWarningDetails(outcome)
        set('pluginOperationNotice', {
          id: `uninstalled-${id}`,
          kind: warningDetails ? 'error' : 'success',
          message: warningDetails
            ? translator()(
                'workbench.plugins_uninstall_partial',
                '{{name}} 已从本机卸载，但部分清理失败：{{details}}',
                {
                  name: pluginName,
                  details: warningDetails,
                  defaultValue: `${pluginName} 已从本机卸载，但部分清理失败：${warningDetails}`,
                }
              )
            : translator()('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
                name: pluginName,
                defaultValue: `${pluginName} 已卸载`,
              }),
        })
        if (warningDetails) track('operation_failed', { operation: 'plugin_uninstall' })
        track('plugin_uninstalled', {
          source: isCloudManagedInstalledPlugin(plugin.raw) ? 'cloud' : 'local',
          ...installedPluginTelemetryIdentity(plugin.raw),
        })
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return
        const rawErrorMessage = getErrorMessage(
          error,
          translator()('workbench.plugins_uninstall_failed', '卸载失败，请稍后重试')
        )
        console.error('[Wework plugins] uninstall plugin failed', {
          pluginId: id,
          error: rawErrorMessage,
        })
        set('pluginOperationNotice', {
          id: `uninstall-error-${id}`,
          kind: 'error',
          message: humanizeMarketplaceUninstallError(rawErrorMessage, translator()),
        })
        track('operation_failed', { operation: 'plugin_uninstall' })
      })
      .finally(() => {
        if (isCurrent())
          set('uninstallingPluginIds', previous => {
            const next = new Set(previous)
            next.delete(id)
            return next
          })
      })
  }
  async function copyMarketplacePlugin(plugin: PluginMarketplaceItem) {
    const isCurrent = currentView()
    const listing = getSnapshot().marketplaceItems.find(
      item => String(item.id) === String(plugin.id)
    )
    if (!isCurrent() || listing?.accessRole !== 'recipient' || !listing.allowCopy) return
    const deviceId = getSnapshot().currentDeviceId
    const inventoryCurrent = capturePluginMarketplaceScope(cacheKey, deviceId)
    try {
      const installed = await observeOperation('plugin.copy', async () => {
        const descriptor = await cloudPluginApi.copyMarketplacePlugin(plugin.id)
        if (!isCurrent()) throw new ExpiredPluginSettingsRequest()
        return localPluginApi.importMarketplaceCopy(descriptor)
      })
      // An accepted local import still belongs to the inventory after this view exits.
      if (!profileIsCurrent() || !inventoryCurrent()) return
      commitPluginInventoryInstallation(cacheKey, deviceId, installed)
      notifyLocalPluginSkillsChanged()
      if (isCurrent()) set('selectedPluginId', toInstalledPluginItem(installed).id)
    } catch (error) {
      if (!isCurrent() || error instanceof ExpiredPluginSettingsRequest) return
      set('pluginOperationNotice', {
        id: `copy-error-${plugin.id}`,
        kind: 'error',
        message: getErrorMessage(error, String(error)),
      })
    }
  }
  return {
    getSnapshot,
    setSelectedPluginId: (value: SetStateAction<PluginManagementState['selectedPluginId']>) =>
      set('selectedPluginId', value),
    setPendingUninstall: (value: SetStateAction<PluginManagementState['pendingUninstall']>) => {
      pendingUninstallOwner = null
      set('pendingUninstall', value)
    },
    setPluginOperationNotice: (value: SetStateAction<PluginOperationNoticeState | null>) =>
      set('pluginOperationNotice', value),
    setActiveTab: (tab: PluginManagementTab) => set('activeTab', tab),
    toggleInstalledPlugin: (id: string | number) => {
      const plugin = getSnapshot().installedPlugins.find(item => String(item.id) === String(id))
      if (plugin) updateSettings(id, !plugin.enabled)
    },
    togglePluginComponent: (id: string | number, key: string, enabled: boolean) =>
      updateSettings(id, enabled, key),
    requestUninstallPlugin: (id: string | number, name: string) => {
      const plugin = getSnapshot().installedPlugins.find(item => String(item.id) === String(id))
      if (!observed() || !profileIsCurrent()) return
      pendingUninstallOwner = currentView()
      set('pendingUninstall', { id, name, scope: pluginUninstallScope(plugin?.raw ?? null) })
    },
    confirmUninstallPlugin: () => {
      const pending = state.pendingUninstall
      if (!pending || !pendingUninstallOwner?.()) return
      pendingUninstallOwner = null
      set('pendingUninstall', null)
      set('uninstallingPluginIds', previous => new Set(previous).add(pending.id))
      uninstallInstalledPlugin(pending.id, pending.name)
    },
    copyMarketplacePlugin,
    observe(nextTranslate: TFunction<'common'>) {
      return {
        subscribe(listener: () => void) {
          translate = nextTranslate
          const version = ++observationGeneration
          listeners.add(listener)
          if (!stopInventory) {
            generation += 1
            stopInventory = subscribePluginMarketplaceCache(next => {
              if (!next) {
                inventory = null
                pendingUninstallOwner = null
                overlays.clear()
                overlayRevision += 1
                state = {
                  ...state,
                  selectedPluginId: null,
                  pendingUninstall: null,
                  pluginOperationNotice: null,
                  uninstallingPluginIds: new Set(),
                }
                loading = false
                publish()
                return
              }
              if (next.cacheKey !== cacheKey || (knownDeviceId && next.deviceId !== knownDeviceId))
                return
              if (inventory && inventory.deviceId !== next.deviceId) {
                pendingUninstallOwner = null
                overlays.clear()
                overlayRevision += 1
                state = {
                  ...state,
                  selectedPluginId: null,
                  pendingUninstall: null,
                  pluginOperationNotice: null,
                  uninstallingPluginIds: new Set(),
                }
              }
              for (const [field, overlay] of overlays)
                if (overlay.rollback) {
                  overlays.delete(field)
                  overlayRevision += 1
                }
              inventory = next
              if (hasLoadedPluginInventory(next)) loading = false
              publish()
            })
            const current = getPluginMarketplaceCache(cacheKey)
            inventory = knownDeviceId && current?.deviceId !== knownDeviceId ? null : current
            projection = null
            scheduleNotice()
            void refresh()
          }
          return () => {
            listeners.delete(listener)
            if (!listeners.size)
              queueMicrotask(() => {
                if (observationGeneration !== version || observed()) return
                generation += 1
                stopInventory?.()
                stopInventory = null
                if (noticeTimer !== null) clearTimeout(noticeTimer)
                noticeTimer = null
                state = { ...state, uninstallingPluginIds: new Set() }
                projection = null
              })
          }
        },
      }
    },
  }
}
