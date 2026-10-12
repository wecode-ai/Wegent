import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { localConnectorAuthHealth } from '@/api/local/localConnectorAuth'
import {
  enrichInstalledPluginsForLocalAuth,
  installedPluginMatchesName,
  listLocalConnectors,
  toLocalConnectorAuthTarget,
} from '@/features/plugins/localConnectorAuthGate'
import type { InstalledPlugin } from '@/types/api'

/** Read current membership and only the mentioned manifests, never a full catalog. */
export async function loadLocalConnectorAuthPlugins(
  pluginNames: string[]
): Promise<InstalledPlugin[]> {
  const names = [...new Set(pluginNames.map(name => name.trim()).filter(Boolean))]
  const api = createLocalCodexPluginApi()
  const { items = [] } = await api.listInstalledPlugins({ requireComplete: true })
  return enrichInstalledPluginsForLocalAuth(
    items,
    plugin => api.readInstalledPluginDetail(plugin),
    {
      shouldEnrich: plugin => names.some(name => installedPluginMatchesName(plugin, name)),
    }
  )
}

/** Warm the existing API cache without retaining a second installed-plugin snapshot. */
export async function prefetchLocalConnectorAuthForPluginNames(
  pluginNames: string[]
): Promise<void> {
  if (!pluginNames.some(name => name.trim())) return
  const plugins = await loadLocalConnectorAuthPlugins(pluginNames)
  const requirements = listLocalConnectors(plugins).filter(requirement =>
    pluginNames.some(name => installedPluginMatchesName(requirement.plugin, name))
  )
  await Promise.allSettled(
    requirements.map(requirement =>
      localConnectorAuthHealth(toLocalConnectorAuthTarget(requirement))
    )
  )
}
