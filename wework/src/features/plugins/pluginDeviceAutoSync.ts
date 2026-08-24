import type { InstalledPlugin, PluginDeviceReportItem, PluginMarketplaceItem } from '@/types/api'
import {
  hasLocalCodexMaterialization,
  localMaterializedVersion,
  localPluginId,
} from '@/components/plugins/installedPluginMerge'

const attemptedDeviceIds = new Set<string>()
const reportedDeviceIds = new Set<string>()
const reportedPayloadKeys = new Set<string>()
const settledDeviceIds = new Set<string>()
const inFlightDeviceIds = new Set<string>()

export function clearPluginDeviceAutoSyncAttempts() {
  attemptedDeviceIds.clear()
  reportedDeviceIds.clear()
  reportedPayloadKeys.clear()
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

function deviceReportPayloadKey(deviceId: string, plugins: PluginDeviceReportItem[]): string {
  const normalized = deviceId.trim()
  const payload = [...plugins]
    .sort((left, right) => left.installedPluginId - right.installedPluginId)
    .map(plugin => `${plugin.installedPluginId}:${plugin.releaseId}:${plugin.version}`)
    .join(',')
  return `${normalized}|${payload}`
}

export function hasAttemptedPluginDeviceStatusReport(
  deviceId: string,
  plugins?: PluginDeviceReportItem[]
): boolean {
  if (plugins) return reportedPayloadKeys.has(deviceReportPayloadKey(deviceId, plugins))
  return reportedDeviceIds.has(deviceId.trim())
}

export function markPluginDeviceStatusReportAttempted(
  deviceId: string,
  plugins: PluginDeviceReportItem[]
): void {
  const normalized = deviceId.trim()
  if (!normalized) return
  reportedDeviceIds.add(normalized)
  reportedPayloadKeys.add(deviceReportPayloadKey(normalized, plugins))
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
  // An older local ZIP still needs sync when the account install is not yet
  // materialized on this device. Matching local packages skip sync so status
  // report can clear a stale cloud pending row. Catalog version bumps on an
  // already-installed device go through update / auto-update, not this path.
  if (item.installedLocally && !localPackageLagsCatalogVersion(item)) return false
  const state = item.currentDeviceInstallation?.state
  if (item.currentDeviceInstallation?.actualReleaseId && state === 'failed') return false
  if (!item.installed) return true
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

function deviceStatusReport(
  plugin: InstalledPlugin,
  deviceId: string,
  desiredVersion?: string | null,
  observedReleaseId?: number | null
): PluginDeviceReportItem | null {
  if (!installedPluginNeedsDeviceStatusReport(plugin, deviceId)) return null
  const installedPluginId = numericInstalledPluginId(plugin)
  const version = localMaterializedVersion(plugin)
  const desired = (desiredVersion ?? plugin.spec.version ?? '').trim()
  const device = plugin.status.devices?.find(row => row.deviceId === deviceId)
  const releaseId = firstPositiveIntegerId(
    observedReleaseId,
    device?.desiredReleaseId,
    plugin.spec.releaseId
  )
  if (installedPluginId === null || !version || version !== desired || releaseId === null) {
    return null
  }
  return { installedPluginId, releaseId, version }
}

function marketplaceDeviceStatusReport(
  item: PluginMarketplaceItem,
  plugin: InstalledPlugin,
  deviceId: string
): PluginDeviceReportItem | null {
  if (!marketplaceItemNeedsDeviceStatusReport(item)) return null
  if (plugin.spec.installState === 'update_available') return null
  const installedPluginId = numericInstalledPluginId(plugin)
  const expectedInstalledPluginId = firstPositiveIntegerId(item.installedPluginId)
  const version = (item.installedVersion ?? '').trim()
  const desiredVersion = (item.version ?? plugin.spec.version ?? '').trim()
  const device = plugin.status.devices?.find(row => row.deviceId === deviceId)
  const releaseId = firstPositiveIntegerId(
    item.currentDeviceInstallation?.desiredReleaseId,
    item.latestReleaseId,
    device?.desiredReleaseId,
    plugin.spec.releaseId
  )
  if (
    installedPluginId === null ||
    installedPluginId !== expectedInstalledPluginId ||
    !version ||
    version !== desiredVersion ||
    releaseId === null
  ) {
    return null
  }
  return { installedPluginId, releaseId, version }
}

export function collectPluginDeviceStatusReports(
  installedPlugins: InstalledPlugin[],
  marketplaceItems: PluginMarketplaceItem[],
  deviceId: string
): PluginDeviceReportItem[] {
  const reports = new Map<number, PluginDeviceReportItem>()
  for (const plugin of installedPlugins) {
    const report = deviceStatusReport(plugin, deviceId)
    if (report) reports.set(report.installedPluginId, report)
  }
  const installedById = new Map(
    installedPlugins.flatMap(plugin => {
      const id = numericInstalledPluginId(plugin)
      return id === null ? [] : [[id, plugin] as const]
    })
  )
  for (const item of marketplaceItems) {
    const plugin = installedById.get(Number(item.installedPluginId))
    if (!plugin) continue
    const report = marketplaceDeviceStatusReport(item, plugin, deviceId)
    if (report) reports.set(report.installedPluginId, report)
  }
  return Array.from(reports.values())
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
