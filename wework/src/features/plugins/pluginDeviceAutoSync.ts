import type { PluginMarketplaceItem } from '@/types/api'

const attemptedDeviceIds = new Set<string>()
const settledDeviceIds = new Set<string>()

export function clearPluginDeviceAutoSyncAttempts() {
  attemptedDeviceIds.clear()
  settledDeviceIds.clear()
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
  if (!item.installed) return true
  const state = item.currentDeviceInstallation?.state
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
