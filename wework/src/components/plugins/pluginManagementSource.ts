import type { TFunction } from 'i18next'
import { DshExecutorTransportError } from '@/api/dsh/executorTransport'
import { gt, valid } from 'semver'
import type { SetStateAction } from 'react'
import type {
  ConfiguredCodexMarketplace,
  CodexMarketplacePluginVersion,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
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
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { marketplaceItemCanRetryPluginUpdate } from '@/features/plugins/pluginAutoUpdate'
import { currentDeviceInstallation } from './workspace/marketplaceWorkspaceHelpers'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import { clearLocalConnectorAuthHealthCache } from '@/api/local/localConnectorAuth'
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
import { ownedPersonalPluginSourceKey } from './workspace/personalPluginCloudInstall'

export type PluginManagementTab = 'codex' | 'core-dsh' | 'marketplaces'
interface SourceOptions {
  cacheKey: string
  knownDeviceId: string
  localPluginApi: ReturnType<typeof createLocalCodexPluginApi>
  cloudPluginApi: ReturnType<typeof createLocalDevicePluginApi> & {
    updatePublishedRelease: ReturnType<typeof createLocalDevicePluginApi>['updateInstalledPlugin']
  }
  cloudAvailable: boolean
}
type PluginVersionHint = { current: string; version: string }
interface PluginManagementState {
  pendingUninstall: { id: string | number; name: string; scope: PluginUninstallScope } | null
  uninstallingPluginIds: Set<string | number>
  pluginOperationNotice: PluginOperationNoticeState | null
  activeTab: PluginManagementTab
  updatingPluginId: string | number | null
  checkingMarketplaces: ReadonlySet<string>
  gitMarketplaceVersions: ReadonlyMap<
    string,
    { sourceRevision: string; versions: ReadonlyMap<string, PluginVersionHint> }
  >
  publishedMarketplaceItems: PluginMarketplaceItem[]
}
interface SettingsOverlay {
  token: symbol
  id: string
  rollback?: boolean
  enabled: boolean
}
export function findGitMarketplaceVersionHint(
  plugin: InstalledPlugin,
  catalogs: PluginManagementState['gitMarketplaceVersions']
) {
  const marketplace = installedPluginMarketplaceId(plugin)
  const hint = marketplace
    ? catalogs.get(marketplace)?.versions.get(plugin.spec.source.pluginKey)
    : undefined
  return hint?.current === plugin.spec.version ? hint : undefined
}

function comparableGitVersion(version: string | null) {
  if (!version) return null
  return valid(version.replace(/^([v]?\d+\.\d+)(?=[+-]|$)/, '$1.0'))
}

function gitVersionHints(checked: CodexMarketplacePluginVersion[]) {
  const hints = new Map<string, PluginVersionHint>()
  let incomplete = false
  for (const { pluginName, installedVersion, version } of checked) {
    const current = comparableGitVersion(installedVersion)
    const latest = comparableGitVersion(version)
    if (current && latest && installedVersion && version) {
      if (!gt(latest, current)) continue
      hints.set(pluginName, { current: installedVersion, version })
    } else {
      incomplete = true
    }
  }
  return { hints, incomplete }
}

export function resolvePublishedPluginUpdate(
  plugin: InstalledPluginItem,
  listing?: PluginMarketplaceItem | null
) {
  if (
    !listing?.installedPluginId ||
    !listing.latestReleaseId ||
    !listing.version ||
    !isCloudManagedInstalledPlugin(plugin.raw) ||
    !marketplaceItemCanRetryPluginUpdate(listing)
  )
    return null
  return {
    id: listing.installedPluginId,
    releaseId: listing.latestReleaseId,
    current: listing.installedVersion ?? plugin.version,
    version: listing.version,
    marketplaceItemId: listing.id,
  }
}

const EMPTY_MARKETPLACE: PluginMarketplaceItem[] = []

/** One Backend/account/device inventory owns selection and pending management operations. */
export function createPluginManagementSource({
  cacheKey,
  knownDeviceId,
  localPluginApi,
  cloudPluginApi,
  cloudAvailable,
}: SourceOptions) {
  const epoch = getPluginMarketplaceAccountEpoch()
  const cached = getPluginMarketplaceCache(cacheKey)
  let inventory = knownDeviceId && cached?.deviceId !== knownDeviceId ? null : cached
  let loading = !hasLoadedPluginInventory(inventory)
  let state: PluginManagementState = {
    pendingUninstall: null,
    uninstallingPluginIds: new Set(),
    pluginOperationNotice: null,
    activeTab: 'codex',
    updatingPluginId: null,
    checkingMarketplaces: new Set(),
    gitMarketplaceVersions: new Map(),
    publishedMarketplaceItems: [],
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
  let publishedRead = 0
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
          plugin = { ...plugin, spec: { ...plugin.spec, enabled: overlay.enabled } }
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
  async function refreshPublishedMarketplace(deviceId: string) {
    if (!cloudAvailable || !deviceId || state.activeTab !== 'codex') return
    const request = ++publishedRead
    const version = generation
    const isCurrent = () =>
      observed() &&
      version === generation &&
      request === publishedRead &&
      profileIsCurrent() &&
      getSnapshot().currentDeviceId === deviceId
    try {
      const { items } = await cloudPluginApi.listMarketplacePlugins({ deviceId })
      if (!Array.isArray(items)) throw new Error('Invalid plugin catalog')
      if (isCurrent()) {
        set('publishedMarketplaceItems', items)
        set('pluginOperationNotice', notice =>
          notice?.id === 'published-versions-load-failed' ? null : notice
        )
      }
    } catch {
      if (isCurrent() && state.activeTab === 'codex') {
        set('pluginOperationNotice', {
          id: 'published-versions-load-failed',
          kind: 'error',
          message: translator()('workbench.plugins_published_versions_load_failed'),
          actionLabel: translator()('common.retry'),
          onAction: () => void refreshPublishedMarketplace(deviceId),
        })
      }
    }
  }

  async function refresh() {
    const version = generation
    const isCurrent = () => observed() && version === generation && profileIsCurrent()
    const initialDeviceId = getSnapshot().currentDeviceId
    void refreshPublishedMarketplace(initialDeviceId)
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
  function updateSettings(id: string | number, enabled: boolean) {
    if (!observed() || !profileIsCurrent()) return
    const snapshot = getSnapshot()
    const plugin = snapshot.installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    const request: PluginSettingsUpdate = { enabled }
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
    const field = String(id)
    const overlay: SettingsOverlay = { token, id: field, enabled }
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
        notifyLocalPluginSkillsChanged()
        track('plugin_enabled_changed', {
          enabled,
          scope: 'plugin',
          source: isCloudManagedInstalledPlugin(plugin.raw) ? 'cloud' : 'local',
          ...installedPluginTelemetryIdentity(plugin.raw),
        })
      })
      .catch(error => {
        if (!operation.isCurrent() || error instanceof ExpiredPluginSettingsRequest) return
        if (overlays.get(field)?.token === token) {
          // Restore the field seen before this action; a later inventory event supplies canonical state.
          overlays.set(field, { token, id: field, rollback: true, enabled: plugin.enabled })
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
      if (isCurrent()) return toInstalledPluginItem(installed)
    } catch (error) {
      if (!isCurrent() || error instanceof ExpiredPluginSettingsRequest) return
      set('pluginOperationNotice', {
        id: `copy-error-${plugin.id}`,
        kind: 'error',
        message: getErrorMessage(error, String(error)),
      })
    }
  }
  let configuredMarketplaceRevisions = new Map<string, string>()

  function forgetGitMarketplaceVersions(id: string) {
    set('gitMarketplaceVersions', previous => {
      if (!previous.has(id)) return previous
      const next = new Map(previous)
      next.delete(id)
      return next
    })
  }

  function reconcileGitMarketplaceSources(marketplaces: ConfiguredCodexMarketplace[]) {
    if (!profileIsCurrent()) return
    configuredMarketplaceRevisions = new Map(
      marketplaces.map(marketplace => [marketplace.id, marketplace.sourceRevision])
    )
    set('gitMarketplaceVersions', previous => {
      const entries = [...previous].filter(
        ([id, catalog]) => configuredMarketplaceRevisions.get(id) === catalog.sourceRevision
      )
      return entries.length === previous.size ? previous : new Map(entries)
    })
  }

  async function checkGitMarketplace(marketplace: ConfiguredCodexMarketplace): Promise<boolean> {
    const version = generation
    const isCurrent = () => observed() && version === generation && profileIsCurrent()
    if (
      !isCurrent() ||
      marketplace.sourceType !== 'git' ||
      state.checkingMarketplaces.has(marketplace.id)
    )
      return false
    set('checkingMarketplaces', previous => new Set([...previous, marketplace.id]))
    try {
      const checked = await localPluginApi.checkGitMarketplaceVersions(
        marketplace.id,
        marketplace.sourceRevision
      )
      if (
        !isCurrent() ||
        configuredMarketplaceRevisions.get(marketplace.id) !== marketplace.sourceRevision
      )
        return false
      const { hints: versions, incomplete } = gitVersionHints(checked)
      set('gitMarketplaceVersions', previous =>
        new Map(previous).set(marketplace.id, {
          sourceRevision: marketplace.sourceRevision,
          versions,
        })
      )
      const count = versions.size
      const t = translator()
      const message = count
        ? t('workbench.plugins_marketplace_new_versions', { name: marketplace.name, count })
        : incomplete
          ? ''
          : t('workbench.plugins_marketplace_no_new_versions', { name: marketplace.name })
      set('pluginOperationNotice', {
        id: 'checked-marketplace-' + marketplace.id,
        kind: incomplete ? 'error' : 'success',
        message: [
          message,
          incomplete
            ? t('workbench.plugins_marketplace_versions_incomplete', { name: marketplace.name })
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      })
    } catch (error) {
      if (isCurrent()) {
        const sourceChanged =
          error instanceof DshExecutorTransportError && error.code === 'marketplace_source_changed'
        if (sourceChanged) forgetGitMarketplaceVersions(marketplace.id)
        set('pluginOperationNotice', {
          id: 'check-marketplace-error-' + marketplace.id,
          kind: 'error',
          message: translator()('workbench.plugins_marketplace_check_failed', {
            name: marketplace.name,
            details: getErrorMessage(error, ''),
          }),
        })
        return sourceChanged
      }
    } finally {
      if (isCurrent())
        set(
          'checkingMarketplaces',
          previous => new Set([...previous].filter(id => id !== marketplace.id))
        )
    }
    return false
  }

  async function preparePublishedPluginUpdate(id: string | number) {
    const isCurrent = currentView()
    if (!isCurrent() || state.updatingPluginId !== null) return null
    const deviceId = getSnapshot().currentDeviceId
    set('updatingPluginId', id)
    try {
      const { items } = await cloudPluginApi.listInstalledPlugins(deviceId)
      if (!isCurrent()) return null
      const releaseId = items.find(item => String(toInstalledPluginItem(item).id) === String(id))
        ?.spec.releaseId
      if (!releaseId) throw new Error('PLUGIN_UPDATE_RELEASE_CHANGED')
      return releaseId
    } catch (error) {
      if (isCurrent()) {
        const message = getErrorMessage(
          error,
          translator()('workbench.plugins_update_release_changed')
        )
        set('pluginOperationNotice', {
          id: 'update-plugin-error-' + id,
          kind: 'error',
          message:
            message === 'PLUGIN_UPDATE_RELEASE_CHANGED'
              ? translator()('workbench.plugins_update_release_changed')
              : message,
        })
      }
      return null
    } finally {
      if (isCurrent()) set('updatingPluginId', null)
    }
  }

  async function updatePublishedPlugin(
    id: string | number,
    targetReleaseId: number,
    expectedCurrentReleaseId: number
  ) {
    const isCurrent = currentView()
    const snapshot = getSnapshot()
    if (!isCurrent() || state.updatingPluginId !== null || !snapshot.currentDeviceId) return
    const plugin = snapshot.installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    const listing = findMarketplaceItemForInstalled(plugin, snapshot.publishedMarketplaceItems)
    const target = resolvePublishedPluginUpdate(plugin, listing)
    if (!target || target.releaseId !== targetReleaseId) {
      set('pluginOperationNotice', {
        id: 'update-plugin-changed-' + id,
        kind: 'error',
        message: translator()('workbench.plugins_update_release_changed'),
      })
      return
    }
    const deviceId = snapshot.currentDeviceId
    const scope = capturePluginMarketplaceScope(cacheKey, deviceId)
    set('updatingPluginId', id)
    try {
      const updated = await cloudPluginApi.updatePublishedRelease(
        target.id,
        { releaseId: target.releaseId, expectedCurrentReleaseId },
        deviceId
      )
      if (!profileIsCurrent() || !scope()) return
      const device = currentDeviceInstallation(updated, deviceId)
      if (device?.actualReleaseId !== target.releaseId || device.state !== 'installed') {
        throw new Error(
          translator()('workbench.plugins_update_failure_named', { name: plugin.name })
        )
      }
      const items =
        getPluginMarketplaceCache(cacheKey)?.marketplaceItems ?? snapshot.marketplaceItems
      const applyReceipt = (item: PluginMarketplaceItem): PluginMarketplaceItem =>
        item.id === target.marketplaceItemId
          ? {
              ...item,
              currentDeviceInstallation: device,
              installedVersion: target.version,
              updateAvailable: item.latestReleaseId !== target.releaseId,
            }
          : item
      commitPluginInventoryInstallation(cacheKey, deviceId, updated, items.map(applyReceipt))
      if (isCurrent()) {
        publishedRead += 1
        set('publishedMarketplaceItems', previous => previous.map(applyReceipt))
      }
      notifyLocalPluginSkillsChanged()
      if (isCurrent())
        set('pluginOperationNotice', {
          id: 'updated-plugin-' + id,
          kind: 'success',
          message: translator()('workbench.plugins_update_success_named', {
            name: plugin.name,
            version: target.version.replace(/^v/i, ''),
          }),
        })
    } catch (error) {
      if (!isCurrent()) return
      const message = getErrorMessage(
        error,
        translator()('workbench.plugins_update_failure_named', { name: plugin.name })
      )
      set('pluginOperationNotice', {
        id: 'update-plugin-error-' + id,
        kind: 'error',
        message:
          message === 'PLUGIN_UPDATE_RELEASE_CHANGED'
            ? translator()('workbench.plugins_update_release_changed')
            : message,
      })
      void refresh()
    } finally {
      if (isCurrent()) set('updatingPluginId', null)
    }
  }

  return {
    getSnapshot,
    preparePublishedPluginUpdate,
    updatePublishedPlugin,
    checkGitMarketplace,
    reconcileGitMarketplaceSources,
    setPendingUninstall: (value: SetStateAction<PluginManagementState['pendingUninstall']>) => {
      pendingUninstallOwner = null
      set('pendingUninstall', value)
    },
    setPluginOperationNotice: (value: SetStateAction<PluginOperationNoticeState | null>) =>
      set('pluginOperationNotice', value),
    refresh,
    removeConfiguredMarketplaceFromInventory(marketplace: ConfiguredCodexMarketplace) {
      if (!profileIsCurrent() || marketplace.installed === null) return
      configuredMarketplaceRevisions.delete(marketplace.id)
      forgetGitMarketplaceVersions(marketplace.id)
      const current = getPluginMarketplaceCache(cacheKey)
      if (current && (!knownDeviceId || current.deviceId === knownDeviceId)) {
        const removedIds = new Set(marketplace.installed.map(plugin => plugin.id))
        setPluginMarketplaceCache(
          {
            ...current,
            installedPlugins: current.installedPlugins.filter(
              plugin =>
                installedPluginMarketplaceId(plugin) !== marketplace.id ||
                !removedIds.has(String(toInstalledPluginItem(plugin).id))
            ),
            marketplaces: current.marketplaces.filter(
              item => item.kind !== 'local' || item.id !== marketplace.id
            ),
            marketplaceItems: current.marketplaceItems.filter(
              item => marketplaceItemMarketplaceId(item) !== marketplace.id
            ),
            selectedMarketplaceKey:
              current.selectedMarketplaceKey === 'local:' + marketplace.id
                ? ''
                : current.selectedMarketplaceKey,
          },
          { mutation: true, persistImmediately: true }
        )
      }
      clearLocalConnectorAuthHealthCache()
      notifyLocalPluginSkillsChanged()
      set('pluginOperationNotice', {
        id: 'remove-marketplace-' + marketplace.id,
        kind: 'success',
        message: translator()('workbench.plugins_marketplace_removed', { name: marketplace.name }),
      })
      void refresh()
    },
    setActiveTab(tab: PluginManagementTab) {
      if (tab === state.activeTab) return
      set('activeTab', tab)
      if (tab === 'codex') void refreshPublishedMarketplace(getSnapshot().currentDeviceId)
    },
    toggleInstalledPlugin: (id: string | number) => {
      const plugin = getSnapshot().installedPlugins.find(item => String(item.id) === String(id))
      if (plugin) updateSettings(id, !plugin.enabled)
    },
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
                  pendingUninstall: null,
                  pluginOperationNotice: null,
                  uninstallingPluginIds: new Set(),
                  updatingPluginId: null,
                  checkingMarketplaces: new Set(),
                  gitMarketplaceVersions: new Map(),
                  publishedMarketplaceItems: [],
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
                  pendingUninstall: null,
                  pluginOperationNotice: null,
                  uninstallingPluginIds: new Set(),
                  updatingPluginId: null,
                  checkingMarketplaces: new Set(),
                  gitMarketplaceVersions: new Map(),
                  publishedMarketplaceItems: [],
                }
              }
              for (const [field, overlay] of overlays)
                if (overlay.rollback) {
                  overlays.delete(field)
                  overlayRevision += 1
                }
              const previousDeviceId = getSnapshot().currentDeviceId
              inventory = next
              if (hasLoadedPluginInventory(next)) loading = false
              publish()
              if (getSnapshot().currentDeviceId !== previousDeviceId)
                void refreshPublishedMarketplace(next.deviceId)
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
                state = {
                  ...state,
                  uninstallingPluginIds: new Set(),
                  updatingPluginId: null,
                  checkingMarketplaces: new Set(),
                }
                projection = null
              })
          }
        },
      }
    },
  }
}
