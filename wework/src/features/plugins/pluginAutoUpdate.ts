import type {
  PluginAutoUpdateBatchResponse,
  PluginDeviceSyncResponse,
  PluginMarketplaceItem,
  PluginMarketplaceListResponse,
} from '@/types/api'
import {
  beginPluginDeviceSync,
  marketplaceNeedsDeviceSync,
} from '@/features/plugins/pluginDeviceAutoSync'

export interface PluginAutoUpdateProgress {
  processedCount: number
  updatedCount: number
  failedCount: number
  remainingCount: number
}

export interface PluginAutoUpdateFailure {
  installedPluginId: number
  pluginName: string
  version: string
  stage: string | null
  errorCode: string | null
  message: string
  retryable: boolean | null
}

export interface PluginAutoUpdateResult {
  updatedCount: number
  failedCount: number
  failures: PluginAutoUpdateFailure[]
}

interface PluginAutoUpdateDependencies {
  updateBatch: () => Promise<PluginAutoUpdateBatchResponse>
  syncPlugin: (installedPluginId: number) => Promise<PluginDeviceSyncResponse>
  syncDevice: () => Promise<PluginDeviceSyncResponse>
  syncWhenNoUpdates?: boolean
  onProgress?: (progress: PluginAutoUpdateProgress) => void
}

interface CurrentDevicePluginAutoUpdateDependencies {
  listLocalInstalledPlugins: () => Promise<{ deviceId?: string }>
  listMarketplacePlugins: (deviceId: string) => Promise<PluginMarketplaceListResponse>
  updateBatch: () => Promise<PluginAutoUpdateBatchResponse>
  syncPlugin: (deviceId: string, installedPluginId: number) => Promise<PluginDeviceSyncResponse>
  syncDevice: (deviceId: string) => Promise<PluginDeviceSyncResponse>
}

export interface CurrentDevicePluginAutoUpdateResult {
  deviceId: string
  updatedCount: number
  failedCount: number
  failures: PluginAutoUpdateFailure[]
  deviceSyncPerformed: boolean
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
  syncPlugin,
  syncDevice,
  syncWhenNoUpdates = false,
  onProgress,
}: PluginAutoUpdateDependencies): Promise<PluginAutoUpdateResult> {
  let processedCount = 0
  let updatedCount = 0
  const failures: PluginAutoUpdateFailure[] = []
  while (true) {
    const batch = await updateBatch()
    if (batch.updatedCount === 0) {
      if (batch.remainingCount > 0) {
        throw new Error('Plugin auto-update made no progress')
      }
      if (processedCount > 0 || !syncWhenNoUpdates) {
        return { updatedCount, failedCount: failures.length, failures }
      }
      failures.push(...collectDeviceSyncFailures(await syncDevice()))
      return { updatedCount, failedCount: failures.length, failures }
    }
    if (batch.updated.length === 0) {
      throw new Error('Plugin auto-update returned no plugin items')
    }

    for (const [index, item] of batch.updated.entries()) {
      processedCount += 1
      try {
        const failure = pluginSyncFailure(item, await syncPlugin(item.installedPluginId))
        if (failure) failures.push(failure)
        else updatedCount += 1
      } catch (error) {
        failures.push({
          installedPluginId: item.installedPluginId,
          pluginName: `Plugin ${item.installedPluginId}`,
          version: item.version,
          stage: null,
          errorCode: null,
          message: errorMessage(error),
          retryable: null,
        })
      }
      onProgress?.({
        processedCount,
        updatedCount,
        failedCount: failures.length,
        remainingCount: batch.remainingCount + batch.updated.length - index - 1,
      })
    }

    if (batch.remainingCount === 0) {
      return { updatedCount, failedCount: failures.length, failures }
    }
  }
}

/**
 * Resolve the live local executor device and run one shared auto-update pass.
 * The marketplace lookup is advisory: a release update can still proceed when
 * catalog refresh fails, while a known pending device row can request a repair
 * sync even after the account installation already advanced.
 */
export async function runCurrentDevicePluginAutoUpdate({
  listLocalInstalledPlugins,
  listMarketplacePlugins,
  updateBatch,
  syncPlugin,
  syncDevice,
}: CurrentDevicePluginAutoUpdateDependencies): Promise<CurrentDevicePluginAutoUpdateResult | null> {
  const local = await listLocalInstalledPlugins()
  const deviceId = local.deviceId?.trim() ?? ''
  if (!deviceId) return null

  const finishDeviceSync = beginPluginDeviceSync(deviceId)
  if (!finishDeviceSync) return null

  try {
    const marketplace = await listMarketplacePlugins(deviceId).catch(() => null)
    let deviceSyncPerformed = false
    const updateResult = await runPluginAutoUpdate({
      updateBatch,
      syncPlugin: installedPluginId => {
        deviceSyncPerformed = true
        return syncPlugin(deviceId, installedPluginId)
      },
      syncDevice: () => {
        deviceSyncPerformed = true
        return syncDevice(deviceId)
      },
      syncWhenNoUpdates: Boolean(marketplace && marketplaceNeedsDeviceSync(marketplace.items)),
    })
    return { deviceId, ...updateResult, deviceSyncPerformed }
  } finally {
    finishDeviceSync()
  }
}

function pluginSyncFailure(
  update: PluginAutoUpdateBatchResponse['updated'][number],
  deviceResult: PluginDeviceSyncResponse
): PluginAutoUpdateFailure | null {
  const item = deviceResult.sync.plugins.find(
    result => String(result.id) === String(update.installedPluginId)
  )
  if (item?.status === 'synced') return null
  const fallback = deviceResult.sync.errors
    .map(error => String(error.error || ''))
    .filter(Boolean)
    .join('; ')
  return {
    installedPluginId: update.installedPluginId,
    pluginName: item?.name?.trim() || `Plugin ${update.installedPluginId}`,
    version: update.version,
    stage: item?.stage?.trim() || null,
    errorCode: item?.error_code?.trim() || null,
    message: item?.error?.trim() || fallback || 'Device did not acknowledge the plugin update',
    retryable: item?.retryable ?? null,
  }
}

function collectDeviceSyncFailures(
  deviceResult: PluginDeviceSyncResponse
): PluginAutoUpdateFailure[] {
  const failures = deviceResult.sync.plugins
    .filter(item => item.status === 'failed' || item.status === 'error')
    .map(item => ({
      installedPluginId: Number(item.id) || 0,
      pluginName: item.name?.trim() || `Plugin ${item.id || ''}`.trim(),
      version: '',
      stage: item.stage?.trim() || null,
      errorCode: item.error_code?.trim() || null,
      message: item.error?.trim() || 'Device rejected the plugin update',
      retryable: item.retryable ?? null,
    }))
  if (failures.length > 0 || deviceResult.sync.success) return failures
  const message = deviceResult.sync.errors
    .map(error => String(error.error || ''))
    .filter(Boolean)
    .join('; ')
  return [
    {
      installedPluginId: 0,
      pluginName: 'Plugin sync',
      version: '',
      stage: null,
      errorCode: null,
      message: message || 'Device rejected plugin synchronization',
      retryable: null,
    },
  ]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}
