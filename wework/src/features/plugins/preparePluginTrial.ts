import type {
  DeviceCapabilityItemResult,
  DeviceCapabilitySyncResponse,
  InstalledPlugin,
  InstalledPluginListResponse,
  PluginMarketplaceInstallResponse,
} from '@/types/api'
import { managedMarketplaceName } from './pluginMarketplaceIdentity'

export class PluginInstallationInspectionError extends Error {}
export class ApplicationPluginSyncConfirmationError extends Error {}

function installedPluginId(plugin: InstalledPlugin): string | null {
  const labels =
    plugin.metadata.labels && typeof plugin.metadata.labels === 'object'
      ? (plugin.metadata.labels as Record<string, unknown>)
      : null
  const value = labels?.id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function pluginSourcePayload(plugin: InstalledPlugin): Record<string, unknown> {
  const payload = plugin.spec.sourcePayload
  return payload && typeof payload === 'object' ? payload : {}
}

function installedPluginMarketplaces(plugin: InstalledPlugin): string[] {
  const payload = pluginSourcePayload(plugin)
  const metadataNamespace =
    typeof plugin.metadata.namespace === 'string' && plugin.metadata.namespace !== 'default'
      ? plugin.metadata.namespace
      : null
  return [
    typeof payload.marketplaceName === 'string' ? payload.marketplaceName : null,
    managedMarketplaceName(plugin),
    plugin.spec.source.marketplace,
    metadataNamespace,
  ]
    .map(candidate => String(candidate ?? '').trim())
    .filter(
      (candidate, index, candidates) =>
        candidate.length > 0 && candidates.indexOf(candidate) === index
    )
}

function installedPluginMatches(
  plugin: InstalledPlugin,
  pluginName: string,
  marketplaceName: string
): boolean {
  const manifestName = plugin.spec.manifest?.name
  const payload = pluginSourcePayload(plugin)
  const nameCandidates = [
    plugin.spec.source.pluginKey,
    payload.pluginName,
    payload.remotePluginId,
    plugin.metadata.name,
    manifestName,
  ]
  const nameMatches = nameCandidates.some(
    candidate => String(candidate ?? '').trim() === pluginName
  )
  const marketplaceMatches = installedPluginMarketplaces(plugin).some(
    candidate => candidate === marketplaceName
  )
  return nameMatches && marketplaceMatches
}

export function applicationPluginReferenceName(plugin: InstalledPlugin, fallback: string): string {
  const manifestName = plugin.spec.manifest?.name
  const payload = pluginSourcePayload(plugin)
  const candidates = [
    plugin.spec.displayName,
    plugin.spec.interface?.displayName,
    plugin.spec.source.pluginKey,
    payload.pluginName,
    payload.remotePluginId,
    plugin.metadata.name,
    manifestName,
    fallback,
  ]
  return (
    candidates
      .map(candidate => String(candidate ?? '').trim())
      .find(candidate => candidate.length > 0) ?? fallback
  )
}

function isPluginInstalledOnDevice(plugin: InstalledPlugin, deviceId: string): boolean {
  const accountInstalled = plugin.spec.installState === 'installed'
  if (!accountInstalled || !plugin.spec.enabled) return false
  return (
    plugin.status.devices?.some(
      device => device.deviceId === deviceId && device.state === 'installed'
    ) ?? false
  )
}

function findInstalledApplicationPlugin(
  plugins: readonly InstalledPlugin[],
  pluginName: string,
  marketplaceName: string,
  deviceId: string
): InstalledPlugin | null {
  return (
    plugins.find(
      plugin =>
        installedPluginMatches(plugin, pluginName, marketplaceName) &&
        isPluginInstalledOnDevice(plugin, deviceId)
    ) ?? null
  )
}

function syncedPluginItemMatches(
  item: DeviceCapabilityItemResult,
  pluginName: string,
  pluginId: string | null
): boolean {
  if (item.status !== 'synced') return false
  return (
    String(item.name ?? '').trim() === pluginName ||
    (pluginId !== null && String(item.id ?? '') === pluginId)
  )
}

function isApplicationPluginSyncConfirmed(
  sync: DeviceCapabilitySyncResponse | null | undefined,
  plugin: InstalledPlugin,
  pluginName: string,
  deviceId: string
): boolean {
  if (!sync) return false
  const pluginId = installedPluginId(plugin)
  const targetResult = Array.isArray(sync.results)
    ? sync.results.find(result => result.device_id === deviceId)
    : null
  if (targetResult) {
    return (
      targetResult.success &&
      targetResult.plugins.some(item => syncedPluginItemMatches(item, pluginName, pluginId))
    )
  }
  return (
    sync.success &&
    sync.failed === 0 &&
    sync.skipped === 0 &&
    (sync.device_id === deviceId || !sync.device_id) &&
    sync.plugins.some(item => syncedPluginItemMatches(item, pluginName, pluginId))
  )
}

interface PreparePluginTrialOptions {
  pluginName: string
  marketplaceName: string
  deviceId: string
  readLocalInstalledPlugins?: () => Promise<InstalledPluginListResponse & { deviceId?: string }>
  listInstalledPlugins: (deviceId: string) => Promise<InstalledPluginListResponse>
  ensureInstalled: (
    pluginName: string,
    deviceId: string
  ) => Promise<PluginMarketplaceInstallResponse>
  onInstalling: () => void
}

/** Reuse target-device membership before entering the shared plugin trial flow. */
export async function preparePluginTrial({
  pluginName,
  marketplaceName,
  deviceId,
  readLocalInstalledPlugins,
  listInstalledPlugins,
  ensureInstalled,
  onInstalling,
}: PreparePluginTrialOptions): Promise<InstalledPlugin> {
  let localDeviceConfirmed = false
  try {
    if (readLocalInstalledPlugins) {
      const local = await readLocalInstalledPlugins()
      localDeviceConfirmed = local.deviceId === deviceId
      if (localDeviceConfirmed) {
        const plugin = local.items.find(
          item =>
            installedPluginMatches(item, pluginName, marketplaceName) &&
            item.spec.installState === 'installed' &&
            item.spec.enabled
        )
        if (plugin) return plugin
      }
    }
    // A local negative result is authoritative; a cloud record must not override it.
    if (!localDeviceConfirmed) {
      const installed = await listInstalledPlugins(deviceId)
      const plugin = findInstalledApplicationPlugin(
        installed.items,
        pluginName,
        marketplaceName,
        deviceId
      )
      if (plugin) return plugin
    }
  } catch (cause) {
    throw new PluginInstallationInspectionError(
      'Failed to check plugin installation on the target device',
      { cause }
    )
  }

  onInstalling()
  const prepared = await ensureInstalled(pluginName, deviceId)
  if (
    !isPluginInstalledOnDevice(prepared.plugin, deviceId) &&
    !isApplicationPluginSyncConfirmed(prepared.sync, prepared.plugin, pluginName, deviceId)
  ) {
    throw new ApplicationPluginSyncConfirmationError(
      'The Backend did not confirm application plugin synchronization to the target device'
    )
  }
  return prepared.plugin
}
