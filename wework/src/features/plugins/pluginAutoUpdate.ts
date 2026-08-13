import type {
  PluginAutoUpdateBatchResponse,
  PluginDeviceSyncResponse,
  PluginMarketplaceItem,
} from '@/types/api'

export interface PluginAutoUpdateProgress {
  updatedCount: number
  remainingCount: number
}

interface PluginAutoUpdateDependencies {
  updateBatch: () => Promise<PluginAutoUpdateBatchResponse>
  syncDevice: () => Promise<PluginDeviceSyncResponse>
  syncWhenNoUpdates?: boolean
  onProgress?: (progress: PluginAutoUpdateProgress) => void
}

export const PLUGIN_AUTO_UPDATE_FAILURE_LIMIT = 3

type PluginUpdateState = Pick<
  PluginMarketplaceItem,
  'updateAvailable' | 'currentDeviceInstallation'
>

export function marketplaceItemCanRetryPluginUpdate(item: PluginUpdateState): boolean {
  if (item.updateAvailable) return true
  return hasFailedReleaseGap(item)
}

export function marketplaceItemNeedsPluginAutoUpdate(item: PluginUpdateState): boolean {
  if (marketplaceItemHasPausedPluginAutoUpdate(item)) return false
  return marketplaceItemCanRetryPluginUpdate(item)
}

export function marketplaceItemHasPausedPluginAutoUpdate(item: PluginUpdateState): boolean {
  const installation = item.currentDeviceInstallation
  return Boolean(
    hasFailedReleaseGap(item) &&
    installation &&
    installation.attemptCount >= PLUGIN_AUTO_UPDATE_FAILURE_LIMIT
  )
}

function hasFailedReleaseGap(item: PluginUpdateState): boolean {
  const installation = item.currentDeviceInstallation
  return Boolean(
    installation?.state === 'failed' &&
    installation.actualReleaseId &&
    installation.actualReleaseId !== installation.desiredReleaseId
  )
}

export async function runPluginAutoUpdate({
  updateBatch,
  syncDevice,
  syncWhenNoUpdates = false,
  onProgress,
}: PluginAutoUpdateDependencies): Promise<number> {
  let totalUpdated = 0
  while (true) {
    const batch = await updateBatch()
    if (batch.updatedCount === 0) {
      if (batch.remainingCount > 0) {
        throw new Error('Plugin auto-update made no progress')
      }
      if (totalUpdated > 0 || !syncWhenNoUpdates) return totalUpdated
      await syncDeviceOrThrow(syncDevice)
      return totalUpdated
    }

    totalUpdated += batch.updatedCount
    onProgress?.({ updatedCount: totalUpdated, remainingCount: batch.remainingCount })

    await syncDeviceOrThrow(syncDevice)
    if (batch.remainingCount === 0) return totalUpdated
  }
}

async function syncDeviceOrThrow(
  syncDevice: () => Promise<PluginDeviceSyncResponse>
): Promise<void> {
  const deviceResult = await syncDevice()
  if (deviceResult.sync.success) return
  const message = deviceResult.sync.errors
    .map(error => String(error.error || ''))
    .filter(Boolean)
    .join('; ')
  throw new Error(message || 'Device rejected plugin auto-update sync')
}
