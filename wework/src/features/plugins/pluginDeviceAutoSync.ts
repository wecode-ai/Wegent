import type { PluginMarketplaceItem } from '@/types/api'

const attemptedDeviceIds = new Set<string>()
const settledDeviceIds = new Set<string>()
const inFlightDeviceIds = new Set<string>()

export function clearPluginDeviceAutoSyncAttempts() {
  attemptedDeviceIds.clear()
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

/** Auto-sync request finished (success or failure) and catalog was refreshed. */
export function markPluginDeviceAutoSyncSettled(deviceId: string): void {
  const normalized = deviceId.trim()
  if (normalized) settledDeviceIds.add(normalized)
}

export function hasSettledPluginDeviceAutoSync(deviceId: string): boolean {
  return settledDeviceIds.has(deviceId.trim())
}

/** Account has an install record but this device still needs materialization. */
export function marketplaceItemNeedsDeviceSync(item: PluginMarketplaceItem): boolean {
  if (item.installedPluginId === null || item.installedPluginId === undefined) {
    return false
  }
  // A matching Codex/App Server install is stronger evidence than a stale cloud
  // device state. Never reinstall a package that is already present locally.
  if (item.installedLocally) return false
  const state = item.currentDeviceInstallation?.state
  // Preserve failed manual updates when an older release is still usable, while
  // allowing a normal pending update to materialize after this device reconnects.
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
