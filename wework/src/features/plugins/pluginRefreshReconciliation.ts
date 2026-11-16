import type { InstalledPlugin, PluginDeviceSyncResponse } from '@/types/api'
import {
  linkedCloudInstalledPluginId,
  localPluginId,
} from '@/components/plugins/installedPluginMerge'
import { logPluginRefreshPhase } from './pluginRefreshDiagnostics'

export type PluginReconciliationStage = 'waiting' | 'reading' | 'syncing' | 'verifying'

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
  diagnosticRequest?: number
  isCurrent: () => boolean
  readStore: () => Promise<InstalledPlugin[]>
  sync: () => Promise<PluginDeviceSyncResponse>
  readCloud: () => Promise<InstalledPlugin[]>
  invalidate: () => void
  onProgress?: (stage: PluginReconciliationStage) => void
}): Promise<void> {
  const measure = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
    const start = Date.now()
    logPluginRefreshPhase(`${phase}-start`, { request: options.diagnosticRequest })
    let outcome: 'completed' | 'failed' = 'failed'
    try {
      const result = await run()
      outcome = 'completed'
      return result
    } finally {
      logPluginRefreshPhase(`${phase}-end`, {
        request: options.diagnosticRequest,
        elapsedMs: Date.now() - start,
        outcome,
      })
    }
  }
  // This also checks runtime support before sending a mutating request.
  if (!options.isCurrent()) return
  options.onProgress?.('reading')
  await measure('reconcile-inventory', options.readStore)
  if (!options.isCurrent()) return
  options.onProgress?.('syncing')
  const response = await measure('reconcile-sync', options.sync)
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
  options.onProgress?.('verifying')
  options.invalidate()
  const [cloud, store] = await measure('reconcile-readback', () =>
    Promise.all([options.readCloud(), options.readStore()])
  )
  if (!options.isCurrent()) return
  verifyReconciledPluginInventory(cloud, store)
}
