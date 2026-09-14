import type { InstalledPlugin, PluginDeviceSyncResponse } from '@/types/api'
import {
  linkedCloudInstalledPluginId,
  localPluginId,
} from '@/components/plugins/installedPluginMerge'

export function verifyReconciledPluginInventory(
  cloud: InstalledPlugin[],
  store: InstalledPlugin[]
): void {
  const desired = new Map(cloud.map(plugin => [String(localPluginId(plugin)), plugin]))
  const actual = new Map(
    store.map(plugin => [String(linkedCloudInstalledPluginId(plugin)), plugin])
  )
  if (
    cloud.some(plugin => localPluginId(plugin) === null) ||
    store.some(plugin => linkedCloudInstalledPluginId(plugin) === null) ||
    cloud.length !== desired.size ||
    desired.size !== actual.size ||
    store.length !== actual.size
  ) {
    throw new Error('Managed plugin inventory is still inconsistent')
  }
  for (const [id, plugin] of desired) {
    const local = actual.get(id)
    if (!local || local.spec.enabled !== plugin.spec.enabled) {
      throw new Error('Managed plugin installation was not confirmed on this device')
    }
  }
}

export async function reconcilePluginRefresh(options: {
  isCurrent: () => boolean
  readStore: () => Promise<InstalledPlugin[]>
  sync: () => Promise<PluginDeviceSyncResponse>
  readCloud: () => Promise<InstalledPlugin[]>
  invalidate: () => void
}): Promise<void> {
  // This also checks runtime support before sending a mutating request.
  await options.readStore()
  if (!options.isCurrent()) return
  const response = await options.sync()
  if (!options.isCurrent()) return
  if (
    !response.reconciled ||
    !response.sync.success ||
    response.sync.failed > 0 ||
    response.sync.errors.length > 0 ||
    response.sync.plugins.some(item => item.status === 'failed')
  ) {
    throw new Error('Plugin reconciliation did not complete; update the app or retry refresh')
  }
  options.invalidate()
  const [cloud, store] = await Promise.all([options.readCloud(), options.readStore()])
  if (!options.isCurrent()) return
  verifyReconciledPluginInventory(cloud, store)
}
