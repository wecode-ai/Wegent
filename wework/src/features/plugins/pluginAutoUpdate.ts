import { beginOperation } from '@/telemetry/operationBus'
import type {
  PluginAutoUpdateBatchResponse,
  PluginDeviceSyncResponse,
  PluginMarketplaceItem,
  PluginMarketplaceListResponse,
} from '@/types/api'
import {
  acquirePluginDeviceSync,
  marketplaceItemNeedsDeviceSync,
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

type PluginSyncTarget = Pick<
  PluginAutoUpdateBatchResponse['updated'][number],
  'installedPluginId' | 'version'
>

interface PluginAutoUpdateDependencies {
  updateBatch: () => Promise<PluginAutoUpdateBatchResponse>
  syncPlugin: (installedPluginId: number) => Promise<PluginDeviceSyncResponse>
  readPendingInstalls?: () => Promise<PluginSyncTarget[]>
  onProgress?: (progress: PluginAutoUpdateProgress) => void
}

interface CurrentDevicePluginAutoUpdateDependencies {
  localSync?: boolean
  signal?: AbortSignal
  listLocalInstalledPlugins: () => Promise<{ deviceId?: string; partial?: boolean }>
  listMarketplacePlugins: (deviceId: string) => Promise<PluginMarketplaceListResponse>
  updateBatch: () => Promise<PluginAutoUpdateBatchResponse>
  syncPlugin: (deviceId: string, installedPluginId: number) => Promise<PluginDeviceSyncResponse>
}

export interface CurrentDevicePluginAutoUpdateResult {
  deviceId: string
  updatedCount: number
  failedCount: number
  failures: PluginAutoUpdateFailure[]
  deviceSyncPerformed: boolean
}

class PluginAutoUpdateConfirmationError extends Error {}

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
  readPendingInstalls,
  onProgress,
}: PluginAutoUpdateDependencies): Promise<PluginAutoUpdateResult> {
  const attempt = beginOperation('plugin.auto_update')
  try {
    const result = await runPluginAutoUpdatePass({
      updateBatch,
      syncPlugin,
      readPendingInstalls,
      onProgress,
    })
    if (result.failedCount > 0) attempt.fail('confirm')
    else if (result.updatedCount > 0 || readPendingInstalls) attempt.succeed()
    else attempt.cancel()
    return result
  } catch (error) {
    attempt.fail(error instanceof PluginAutoUpdateConfirmationError ? 'confirm' : 'request')
    throw error
  }
}

async function runPluginAutoUpdatePass({
  updateBatch,
  syncPlugin,
  readPendingInstalls,
  onProgress,
}: PluginAutoUpdateDependencies): Promise<PluginAutoUpdateResult> {
  let processedCount = 0
  let updatedCount = 0
  const failures: PluginAutoUpdateFailure[] = []
  while (true) {
    const batch = await updateBatch()
    if (batch.updatedCount === 0) {
      if (batch.remainingCount > 0) {
        throw new PluginAutoUpdateConfirmationError('Plugin auto-update made no progress')
      }
      if (processedCount === 0 && readPendingInstalls) {
        for (const item of await readPendingInstalls()) {
          const failure = await syncPluginUpdate(item, syncPlugin)
          if (failure) failures.push(failure)
        }
      }
      return { updatedCount, failedCount: failures.length, failures }
    }
    if (batch.updated.length === 0) {
      throw new Error('Plugin auto-update returned no plugin items')
    }

    for (const [index, item] of batch.updated.entries()) {
      processedCount += 1
      const failure = await syncPluginUpdate(item, syncPlugin, true)
      if (failure) failures.push(failure)
      else updatedCount += 1
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
  localSync = false,
  signal,
  listLocalInstalledPlugins,
  listMarketplacePlugins,
  updateBatch,
  syncPlugin,
}: CurrentDevicePluginAutoUpdateDependencies): Promise<CurrentDevicePluginAutoUpdateResult | null> {
  const local: { deviceId?: string; partial?: boolean } = localSync
    ? {}
    : await listLocalInstalledPlugins()
  const deviceId = local.deviceId?.trim() ?? ''
  if (!localSync && !deviceId) return null

  // The Native coordinator serializes account-scoped HTTP execution itself.
  const finishDeviceSync = localSync
    ? () => undefined
    : await acquirePluginDeviceSync(deviceId, signal, 'auto-update')

  try {
    if (local.partial) {
      throw new Error('Plugin auto-update requires a complete local plugin inventory')
    }
    let deviceSyncPerformed = false
    const updateResult = await runPluginAutoUpdate({
      updateBatch,
      syncPlugin: installedPluginId => {
        deviceSyncPerformed = true
        return syncPlugin(deviceId, installedPluginId)
      },
      readPendingInstalls: async () => {
        const marketplace = await listMarketplacePlugins(deviceId).catch(() => null)
        return pendingPluginSyncTargets(marketplace?.items ?? [])
      },
    })
    return { deviceId, ...updateResult, deviceSyncPerformed }
  } finally {
    finishDeviceSync()
  }
}

function pluginSyncFailure(
  update: PluginSyncTarget,
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

export function pendingPluginSyncTargets(items: PluginMarketplaceItem[]): PluginSyncTarget[] {
  return items.flatMap(item => {
    const retryRelease =
      hasFailedReleaseGap(item) && !marketplaceItemHasPausedPluginAutoUpdate(item)
    if (!marketplaceItemNeedsDeviceSync(item) && !retryRelease) {
      return []
    }
    const installedPluginId = Number(item.installedPluginId)
    return Number.isSafeInteger(installedPluginId) && installedPluginId > 0
      ? [{ installedPluginId, version: item.version ?? '' }]
      : []
  })
}

async function syncPluginUpdate(
  item: PluginSyncTarget,
  syncPlugin: PluginAutoUpdateDependencies['syncPlugin'],
  requireVersion = false
): Promise<PluginAutoUpdateFailure | null> {
  const installedPluginId =
    Number.isSafeInteger(item?.installedPluginId) && item.installedPluginId > 0
      ? item.installedPluginId
      : 0
  const version = typeof item?.version === 'string' ? item.version : ''
  try {
    if (!installedPluginId || (requireVersion && !version.trim())) {
      throw new Error('Invalid plugin auto-update item')
    }
    return pluginSyncFailure(item, await syncPlugin(installedPluginId))
  } catch (error) {
    return {
      installedPluginId,
      pluginName: installedPluginId ? `Plugin ${installedPluginId}` : 'Invalid plugin update',
      version,
      stage: null,
      errorCode: null,
      message: errorMessage(error),
      retryable: null,
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}
