import type { InstalledPlugin, InstalledPluginListResponse } from '@/types/api'
import { isLocalPluginUninstallCleanupError } from '@/api/local/pluginUninstallError'
import {
  isCloudManagedInstalledPlugin,
  isIndependentPublishedSource,
  isWegentManagedStorePlugin,
  linkedCloudInstalledPluginId,
  linkedCloudPluginId,
} from './installedPluginMerge'

interface PluginUninstallOperations {
  readLocalInstalled(): Promise<InstalledPluginListResponse>
  readCloudInstalled(): Promise<InstalledPluginListResponse>
  isCurrent(): boolean
  logoutLocal(plugin: InstalledPlugin): Promise<void>
  uninstallCloud(id: string | number, deviceId?: string): Promise<void>
  uninstallLocal(id: string | number): Promise<void>
}

type AccountUninstallOperations = Pick<
  PluginUninstallOperations,
  'readCloudInstalled' | 'isCurrent' | 'uninstallCloud'
>

export interface PluginUninstallOutcome {
  warnings: Error[]
}

export type PluginUninstallScope = 'local' | 'account' | 'published-source'

export function pluginUninstallScope(plugin: InstalledPlugin | null): PluginUninstallScope {
  if (!plugin) return 'account'
  if (isIndependentPublishedSource(plugin)) return 'published-source'
  return isCloudManagedInstalledPlugin(plugin) ||
    isWegentManagedStorePlugin(plugin) ||
    linkedCloudPluginId(plugin) !== null ||
    linkedCloudInstalledPluginId(plugin) !== null
    ? 'account'
    : 'local'
}

export function pluginUninstallWarningDetails(outcome: PluginUninstallOutcome): string | null {
  const details = outcome.warnings
    .map(warning => warning.message)
    .filter(Boolean)
    .join('; ')
  return details || null
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function accountInstallId(plugin: InstalledPlugin): string | number | null {
  const labels = plugin?.metadata?.labels
  const id = labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : null
  return (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
    (typeof id === 'string' && /^[1-9]\d*$/.test(id))
    ? id
    : null
}

function validateAccountInventory(inventory: InstalledPluginListResponse): void {
  if (!Array.isArray(inventory?.items)) throw unconfirmed()
  const ids = new Set<string>()
  for (const candidate of inventory.items) {
    const id = accountInstallId(candidate)
    const source = candidate?.spec?.source
    if (
      id === null ||
      ids.has(String(id)) ||
      !source ||
      typeof source.providerKey !== 'string' ||
      typeof source.pluginKey !== 'string' ||
      !source.pluginKey
    )
      throw unconfirmed()
    ids.add(String(id))
    const pluginId = candidate.spec.pluginId
    if (typeof pluginId === 'number' && Number.isSafeInteger(pluginId) && pluginId > 0) continue
    // The existing upload and legacy Kind-marketplace APIs own independent
    // resources without a Plugin catalog ID. New catalog rows always have one.
    const legacyUpload =
      source.type === 'upload' &&
      source.providerKey === 'codex-local' &&
      source.catalogItemId == null
    const legacyMarketplace =
      source.type === 'marketplace' &&
      source.providerKey === 'wegent-marketplace' &&
      typeof source.catalogItemId === 'string' &&
      /^[1-9]\d*$/.test(source.catalogItemId)
    if (pluginId != null || (!legacyUpload && !legacyMarketplace)) throw unconfirmed()
  }
}

function assertCurrent(operations: Pick<PluginUninstallOperations, 'isCurrent'>): void {
  if (!operations.isCurrent())
    throw new Error('Plugin uninstall cancelled after account scope changed')
}

async function readAccountInstall(
  cloudPluginId: number | null,
  linkedInstallId: string | number | null,
  operations: AccountUninstallOperations
): Promise<string | number | null> {
  try {
    const inventory = await operations.readCloudInstalled()
    assertCurrent(operations)
    return findAccountInstall(inventory, cloudPluginId, linkedInstallId)
  } catch (error) {
    assertCurrent(operations)
    throw unconfirmed(error)
  }
}

export async function uninstallAccountPlugin(
  cloudPluginId: string | number,
  deviceId: string | undefined,
  operations: AccountUninstallOperations
): Promise<void> {
  assertCurrent(operations)
  const pluginId =
    typeof cloudPluginId === 'string' && /^[1-9]\d*$/.test(cloudPluginId)
      ? Number(cloudPluginId)
      : cloudPluginId
  if (typeof pluginId !== 'number' || !Number.isSafeInteger(pluginId) || pluginId <= 0) {
    throw unconfirmed()
  }
  const currentId = await readAccountInstall(pluginId, null, operations)
  assertCurrent(operations)
  if (currentId === null) return
  try {
    await operations.uninstallCloud(currentId, deviceId)
  } finally {
    assertCurrent(operations)
  }
}

function unconfirmed(error?: unknown): Error {
  return new Error('PLUGIN_UNINSTALL_PREFLIGHT_FAILED', { cause: error })
}

function findAccountInstall(
  inventory: InstalledPluginListResponse,
  cloudPluginId: number | null,
  linkedInstallId: string | number | null
): string | number | null {
  validateAccountInventory(inventory)
  const byInstallId = inventory.items.filter(
    candidate =>
      linkedInstallId !== null && String(accountInstallId(candidate)) === String(linkedInstallId)
  )
  if (
    cloudPluginId !== null &&
    byInstallId.some(candidate => candidate.spec.pluginId !== cloudPluginId)
  )
    throw unconfirmed()
  const matches =
    cloudPluginId === null
      ? byInstallId
      : inventory.items.filter(candidate => candidate.spec.pluginId === cloudPluginId)
  if (matches.length > 1) throw unconfirmed()
  if (!matches[0]) return null
  const currentId = accountInstallId(matches[0])
  if (currentId === null) throw unconfirmed()
  return currentId
}

async function resolveAccountUninstall(
  plugin: InstalledPlugin,
  id: string | number,
  operations: PluginUninstallOperations
): Promise<string | number | null> {
  const cloudManaged = isCloudManagedInstalledPlugin(plugin)
  const linkedInstallId = cloudManaged ? id : linkedCloudInstalledPluginId(plugin)
  const cloudPluginId = cloudManaged ? plugin.spec.pluginId! : linkedCloudPluginId(plugin)
  if (isWegentManagedStorePlugin(plugin) && linkedInstallId === null && cloudPluginId === null) {
    throw new Error(
      'Managed plugin account install id is unavailable; refresh installed plugins and retry uninstall'
    )
  }
  if (cloudPluginId === null && linkedInstallId === null) return null
  if (
    cloudPluginId !== null &&
    linkedInstallId === null &&
    !isIndependentPublishedSource(plugin) &&
    !isWegentManagedStorePlugin(plugin)
  ) {
    throw new Error(
      'Published plugin is linked to the cloud catalog but the account install id is unavailable; refresh installed plugins and retry uninstall'
    )
  }
  const currentId = await readAccountInstall(cloudPluginId, linkedInstallId, operations)
  if (currentId === null && !isIndependentPublishedSource(plugin) && !cloudManaged) {
    throw unconfirmed()
  }
  return currentId
}

export async function uninstallPluginIdentities(
  plugin: InstalledPlugin | null,
  id: string | number,
  deviceId: string | undefined,
  operations: PluginUninstallOperations
): Promise<PluginUninstallOutcome> {
  assertCurrent(operations)
  if (
    !plugin ||
    (!isCloudManagedInstalledPlugin(plugin) &&
      !isWegentManagedStorePlugin(plugin) &&
      linkedCloudPluginId(plugin) === null &&
      linkedCloudInstalledPluginId(plugin) === null)
  ) {
    // Catalog rendering may omit unavailable publication links. Confirm absence
    // with the strict native inventory before treating a plugin as local-only.
    try {
      const inventory = await operations.readLocalInstalled()
      assertCurrent(operations)
      const matches = inventory.items.filter(
        candidate =>
          candidate.metadata.labels &&
          typeof candidate.metadata.labels === 'object' &&
          String((candidate.metadata.labels as Record<string, unknown>).id) === String(id)
      )
      if (matches.length !== 1) throw unconfirmed()
      plugin = matches[0]
    } catch (error) {
      assertCurrent(operations)
      throw unconfirmed(error)
    }
  }
  const cloudInstalledPluginId = await resolveAccountUninstall(plugin, id, operations)
  assertCurrent(operations)
  if (cloudInstalledPluginId !== null) {
    // Clear account intent before any local cleanup so synchronization cannot restore it.
    try {
      await operations.uninstallCloud(cloudInstalledPluginId, deviceId)
    } finally {
      assertCurrent(operations)
    }
  } else if (isCloudManagedInstalledPlugin(plugin)) {
    return { warnings: [] }
  }
  const warnings: Error[] = []
  try {
    await operations.logoutLocal(plugin)
  } catch (error) {
    warnings.push(toError(error))
  } finally {
    assertCurrent(operations)
  }
  if (isCloudManagedInstalledPlugin(plugin) || isWegentManagedStorePlugin(plugin))
    return { warnings }
  try {
    await operations.uninstallLocal(id)
  } catch (error) {
    if (!isLocalPluginUninstallCleanupError(error)) throw error
    warnings.push(toError(error))
  } finally {
    assertCurrent(operations)
  }
  return { warnings }
}
