import type { InstalledPlugin } from '@/types/api'
import { isLocalPluginUninstallCleanupError } from '@/api/local/pluginUninstallError'
import {
  isCloudManagedInstalledPlugin,
  linkedCloudInstalledPluginId,
  linkedCloudPluginId,
} from './installedPluginMerge'

interface PluginUninstallOperations {
  uninstallCloud(id: string | number, deviceId?: string): Promise<void>
  uninstallLocal(id: string | number): Promise<void>
}

export interface PluginUninstallOutcome {
  warnings: Error[]
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

export async function uninstallPluginIdentities(
  plugin: InstalledPlugin,
  id: string | number,
  deviceId: string | undefined,
  operations: PluginUninstallOperations
): Promise<PluginUninstallOutcome> {
  if (isCloudManagedInstalledPlugin(plugin)) {
    await operations.uninstallCloud(id, deviceId)
    return { warnings: [] }
  }

  const warnings: Error[] = []
  const cloudInstalledPluginId = linkedCloudInstalledPluginId(plugin)
  const cloudPluginId = linkedCloudPluginId(plugin)
  if (cloudInstalledPluginId !== null) {
    // Account desired state must be cleared before local removal; otherwise
    // device register / marketplace auto-sync will rematerialize the plugin.
    await operations.uninstallCloud(cloudInstalledPluginId, deviceId)
  } else if (cloudPluginId !== null) {
    throw new Error(
      'Published plugin is linked to the cloud catalog but the account install id is unavailable; refresh installed plugins and retry uninstall'
    )
  }
  try {
    await operations.uninstallLocal(id)
  } catch (error) {
    if (!isLocalPluginUninstallCleanupError(error)) throw error
    warnings.push(toError(error))
  }
  return { warnings }
}
