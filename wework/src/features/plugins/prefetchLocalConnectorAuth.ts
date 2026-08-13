import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { localConnectorAuthHealth } from '@/api/local/localConnectorAuth'
import {
  findLocalConnectorsForMessage,
  installedPluginMatchesName,
  listLocalConnectors,
  toLocalConnectorAuthTarget,
} from '@/features/plugins/localConnectorAuthGate'
import type { InstalledPlugin } from '@/types/api'

let warmedPlugins: InstalledPlugin[] | null = null
const warmedNames = new Set<string>()
let inflight: Promise<void> | null = null

function normalizeNames(pluginNames: string[]): string[] {
  return Array.from(new Set(pluginNames.map(name => name.trim()).filter(name => name.length > 0)))
}

function pluginWarmKey(plugin: InstalledPlugin): string {
  return `${plugin.spec.source.marketplace || plugin.metadata.namespace || ''}:${plugin.spec.source.pluginKey}`.toLowerCase()
}

function hasLocalConnectors(plugin: InstalledPlugin): boolean {
  return (
    listLocalConnectors([plugin], {
      authPolicies: ['on_install', 'on_use'],
    }).length > 0
  )
}

/**
 * Warm install membership + connector localAuth + health before the user hits
 * send. Composer plugin selection should call this so gateBeforeSend is cache-hot.
 */
export async function prefetchLocalConnectorAuthForPluginNames(
  pluginNames: string[]
): Promise<void> {
  const names = normalizeNames(pluginNames)
  if (names.length === 0) return
  if (names.every(name => warmedNames.has(name.toLowerCase())) && warmedPlugins) {
    return
  }

  const run = async () => {
    const api = createLocalCodexPluginApi()
    const items = (await api.listInstalledPlugins()).items ?? []
    const readyNames = new Set<string>()
    const enriched = await Promise.all(
      items.map(async plugin => {
        const matchedNames = names.filter(name => installedPluginMatchesName(plugin, name))
        if (matchedNames.length === 0) return plugin
        if (hasLocalConnectors(plugin)) {
          for (const name of matchedNames) readyNames.add(name.toLowerCase())
          return plugin
        }
        try {
          const detailed = await api.readInstalledPluginDetail(plugin)
          // Detail succeeded — mark warm even when the plugin has no local
          // connectors so peek can skip a redundant refresh on send.
          for (const name of matchedNames) readyNames.add(name.toLowerCase())
          return hasLocalConnectors(detailed) ? detailed : plugin
        } catch {
          return plugin
        }
      })
    )
    // Merge with prior warm detail. A later prefetch for plugin B must not wipe
    // connector/localAuth stubs already warmed for plugin A.
    const previousByKey = new Map(
      (warmedPlugins ?? []).map(plugin => [pluginWarmKey(plugin), plugin])
    )
    warmedPlugins = enriched.map(plugin => {
      if (names.some(name => installedPluginMatchesName(plugin, name))) return plugin
      return previousByKey.get(pluginWarmKey(plugin)) ?? plugin
    })
    for (const name of readyNames) warmedNames.add(name)

    const syntheticMessage = names.map(name => `plugin://${name}@prefetch`).join(' ')
    let requirements = findLocalConnectorsForMessage(syntheticMessage, warmedPlugins)
    if (requirements.length === 0) {
      requirements = listLocalConnectors(warmedPlugins, {
        authPolicies: ['on_install', 'on_use'],
      }).filter(requirement =>
        names.some(name => installedPluginMatchesName(requirement.plugin, name))
      )
    }
    await Promise.allSettled(
      requirements.map(requirement =>
        localConnectorAuthHealth(toLocalConnectorAuthTarget(requirement))
      )
    )
  }

  const task = (inflight ?? Promise.resolve())
    .catch(() => undefined)
    .then(run)
    .finally(() => {
      // Only clear when this task is still the active chain head. An earlier
      // link's finally must not null out a later chained prefetch.
      if (inflight === task) inflight = null
    })
  inflight = task
  await task
}

/** Reuse plugins warmed by composer selection when send preflight runs. */
export function peekWarmedLocalConnectorAuthPlugins(
  pluginNames: string[]
): InstalledPlugin[] | null {
  const names = normalizeNames(pluginNames)
  if (!warmedPlugins || names.length === 0) return null
  if (!names.every(name => warmedNames.has(name.toLowerCase()))) return null
  if (
    !names.every(name => warmedPlugins!.some(plugin => installedPluginMatchesName(plugin, name)))
  ) {
    return null
  }
  return warmedPlugins
}

/** Test helper. */
export function clearLocalConnectorAuthPrefetchCache(): void {
  warmedPlugins = null
  warmedNames.clear()
  inflight = null
}
