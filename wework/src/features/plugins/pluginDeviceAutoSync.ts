import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import {
  hasLocalCodexMaterialization,
  localMaterializedVersion,
  localPluginId,
} from '@/components/plugins/installedPluginMerge'

const attemptedDeviceIds = new Set<string>()
const reportedDeviceIds = new Set<string>()
const settledDeviceIds = new Set<string>()
const inFlightDeviceIds = new Set<string>()

export function clearPluginDeviceAutoSyncAttempts() {
  attemptedDeviceIds.clear()
  reportedDeviceIds.clear()
  settledDeviceIds.clear()
  inFlightDeviceIds.clear()
}

/** Acquire the shared per-device plugin synchronization single-flight lock. */
export function beginPluginDeviceSync(deviceId: string): (() => void) | null {
  const normalized = deviceId.trim()
  if (!normalized || inFlightDeviceIds.has(normalized)) return null
  inFlightDeviceIds.add(normalized)
  return () => inFlightDeviceIds.delete(normalized)
}

export function hasAttemptedPluginDeviceAutoSync(deviceId: string): boolean {
  return attemptedDeviceIds.has(deviceId.trim())
}

export function markPluginDeviceAutoSyncAttempted(deviceId: string): void {
  const normalized = deviceId.trim()
  if (normalized) attemptedDeviceIds.add(normalized)
}

export function hasAttemptedPluginDeviceStatusReport(deviceId: string): boolean {
  return reportedDeviceIds.has(deviceId.trim())
}

export function markPluginDeviceStatusReportAttempted(deviceId: string): void {
  const normalized = deviceId.trim()
  if (normalized) reportedDeviceIds.add(normalized)
}

/** Auto-sync request finished (success or failure) and catalog was refreshed. */
export function markPluginDeviceAutoSyncSettled(deviceId: string): void {
  const normalized = deviceId.trim()
  if (normalized) settledDeviceIds.add(normalized)
}

export function hasSettledPluginDeviceAutoSync(deviceId: string): boolean {
  return settledDeviceIds.has(deviceId.trim())
}

export function hasInFlightPluginDeviceSync(deviceId: string): boolean {
  return inFlightDeviceIds.has(deviceId.trim())
}

function localPackageLagsCatalogVersion(item: PluginMarketplaceItem): boolean {
  const local = (item.installedVersion ?? '').trim()
  const desired = (item.version ?? '').trim()
  return Boolean(local && desired && local !== desired)
}

/** Account has an install record but this device still needs materialization. */
export function marketplaceItemNeedsDeviceSync(item: PluginMarketplaceItem): boolean {
  if (item.installedPluginId === null || item.installedPluginId === undefined) {
    return false
  }
  // An older local ZIP must still sync to the desired release. Matching local
  // packages skip sync so status report can clear a stale cloud pending row.
  if (item.installedLocally && !localPackageLagsCatalogVersion(item)) return false
  const state = item.currentDeviceInstallation?.state
  if (item.currentDeviceInstallation?.actualReleaseId && state === 'failed') return false
  if (!item.installed) return true
  if (localPackageLagsCatalogVersion(item)) return true
  return state === 'failed' || state === 'pending'
}

export function marketplaceNeedsDeviceSync(items: PluginMarketplaceItem[]): boolean {
  return items.some(marketplaceItemNeedsDeviceSync)
}

/**
 * After the once-per-session auto-sync settles, lingering pending gaps should
 * offer retry instead of an endless "syncing" spinner.
 */
export function marketplaceItemOffersDeviceSyncRetry(
  item: PluginMarketplaceItem,
  options: { autoSyncSettled: boolean }
): boolean {
  if (!marketplaceItemNeedsDeviceSync(item)) return false
  const state = item.currentDeviceInstallation?.state
  if (state === 'failed') return true
  return Boolean(options.autoSyncSettled && state === 'pending')
}

export function withOptimisticDevicePending(
  items: PluginMarketplaceItem[],
  deviceId: string
): PluginMarketplaceItem[] {
  const normalizedDeviceId = deviceId.trim()
  if (!normalizedDeviceId) return items
  return items.map(item => {
    if (!marketplaceItemNeedsDeviceSync(item)) return item
    const previous = item.currentDeviceInstallation
    return {
      ...item,
      currentDeviceInstallation: {
        deviceId: previous?.deviceId || normalizedDeviceId,
        desiredReleaseId: previous?.desiredReleaseId ?? item.latestReleaseId ?? 0,
        actualReleaseId: previous?.actualReleaseId ?? null,
        state: 'pending',
        errorCode: null,
        errorMessage: null,
        attemptCount: previous?.attemptCount ?? 0,
        lastSyncAt: previous?.lastSyncAt ?? null,
        updatedAt: previous?.updatedAt || new Date().toISOString(),
      },
    }
  })
}

function firstPositiveIntegerId(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const parsed = Number(value)
      if (parsed > 0) return parsed
    }
  }
  return null
}

function numericInstalledPluginId(plugin: InstalledPlugin): number | null {
  const labels = plugin.metadata.labels
  const labelId =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : null
  const payload = plugin.spec.sourcePayload
  return firstPositiveIntegerId(
    labelId,
    payload && typeof payload === 'object' ? payload.cloudInstalledPluginId : null,
    localPluginId(plugin)
  )
}

function localVersionMatchesDesired(
  plugin: InstalledPlugin,
  desiredVersion?: string | null
): boolean {
  const localVersion = localMaterializedVersion(plugin)
  const desired = (desiredVersion ?? plugin.spec.version ?? '').trim()
  if (!localVersion || !desired) return true
  return localVersion === desired
}

function hasReleaseGap(device: {
  actualReleaseId?: number | null
  desiredReleaseId: number
}): boolean {
  return Boolean(device.actualReleaseId && device.actualReleaseId !== device.desiredReleaseId)
}

export function installedPluginNeedsDeviceStatusReport(
  plugin: InstalledPlugin,
  deviceId: string
): boolean {
  if (!hasLocalCodexMaterialization(plugin)) return false
  if (typeof plugin.spec.pluginId !== 'number') return false
  if (plugin.spec.installState === 'update_available') return false
  if (numericInstalledPluginId(plugin) === null) return false
  if (!localVersionMatchesDesired(plugin)) return false
  const device = plugin.status.devices?.find(row => row.deviceId === deviceId)
  if (device?.state === 'uninstalling' || device?.state === 'installed') return false
  if (device && hasReleaseGap(device)) return false
  if (device) return true
  return (plugin.status.devices?.length ?? 0) > 0 || plugin.spec.installState === 'not_installed'
}

export function marketplaceItemNeedsDeviceStatusReport(item: PluginMarketplaceItem): boolean {
  if (!item.installedLocally || item.updateAvailable) return false
  const installedPluginId = Number(item.installedPluginId)
  if (!Number.isInteger(installedPluginId) || installedPluginId <= 0) return false
  const state = item.currentDeviceInstallation?.state
  if (item.currentDeviceInstallation && hasReleaseGap(item.currentDeviceInstallation)) {
    return false
  }
  return (
    state === 'pending' || state === 'failed' || state === 'downloading' || state === 'installing'
  )
}

export function collectInstalledPluginIdsNeedingDeviceStatusReport(
  installedPlugins: InstalledPlugin[],
  marketplaceItems: PluginMarketplaceItem[],
  deviceId: string
): number[] {
  const ids = new Set<number>()
  for (const plugin of installedPlugins) {
    if (!installedPluginNeedsDeviceStatusReport(plugin, deviceId)) continue
    const id = numericInstalledPluginId(plugin)
    if (id !== null) ids.add(id)
  }
  const installedById = new Map(
    installedPlugins.flatMap(plugin => {
      const id = numericInstalledPluginId(plugin)
      return id === null ? [] : [[id, plugin] as const]
    })
  )
  for (const item of marketplaceItems) {
    if (!marketplaceItemNeedsDeviceStatusReport(item)) continue
    const plugin = installedById.get(Number(item.installedPluginId))
    if (plugin && !localVersionMatchesDesired(plugin, item.version)) continue
    ids.add(Number(item.installedPluginId))
  }
  return Array.from(ids)
}

export function withAcknowledgedDeviceInstallations(
  plugins: InstalledPlugin[],
  deviceId: string,
  installedPluginIds: number[]
): InstalledPlugin[] {
  const acknowledged = new Set(installedPluginIds)
  const now = new Date().toISOString()
  return plugins.map(plugin => {
    const id = numericInstalledPluginId(plugin)
    if (id === null || !acknowledged.has(id)) return plugin
    const devices = plugin.status.devices ?? []
    const existing = devices.find(device => device.deviceId === deviceId)
    const nextDevice = {
      deviceId,
      desiredReleaseId: existing?.desiredReleaseId ?? plugin.spec.releaseId ?? 0,
      actualReleaseId: existing?.desiredReleaseId ?? plugin.spec.releaseId ?? 0,
      state: 'installed' as const,
      errorCode: null,
      errorMessage: null,
      attemptCount: 0,
      lastSyncAt: now,
      updatedAt: now,
    }
    return {
      ...plugin,
      spec: { ...plugin.spec, installState: 'installed' as const },
      status: {
        ...plugin.status,
        state: 'installed',
        devices: existing
          ? devices.map(device => (device.deviceId === deviceId ? nextDevice : device))
          : [...devices, nextDevice],
      },
    }
  })
}

export function withAcknowledgedMarketplaceDeviceState(
  items: PluginMarketplaceItem[],
  deviceId: string,
  installedPluginIds: number[]
): PluginMarketplaceItem[] {
  const acknowledged = new Set(installedPluginIds.map(String))
  const now = new Date().toISOString()
  return items.map(item => {
    if (!acknowledged.has(String(item.installedPluginId ?? ''))) return item
    const previous = item.currentDeviceInstallation
    const desiredReleaseId = previous?.desiredReleaseId ?? item.latestReleaseId ?? 0
    return {
      ...item,
      installed: true,
      currentDeviceInstallation: {
        deviceId: previous?.deviceId || deviceId,
        desiredReleaseId,
        actualReleaseId: desiredReleaseId,
        state: 'installed',
        errorCode: null,
        errorMessage: null,
        attemptCount: 0,
        lastSyncAt: now,
        updatedAt: now,
      },
    }
  })
}
