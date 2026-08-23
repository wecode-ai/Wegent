import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { applyInstalledPluginsToMarketplaceItems } from '@/api/local/codexPlugins'
import { sameMarketplaceItems } from '@/features/plugins/pluginMarketplaceCache'
import {
  hasLocalCodexMaterialization,
  isCloudManagedInstalledPlugin,
} from '../installedPluginMerge'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginMarketplaceState } from '../workspace/marketplaceWorkspaceHelpers'

export function usePluginMarketplaceCatalog({
  installedPlugins,
  setPluginMarketplaceState,
}: {
  installedPlugins: InstalledPluginItem[]
  setPluginMarketplaceState: Dispatch<SetStateAction<PluginMarketplaceState>>
}) {
  useEffect(() => {
    const installedRaw = installedPlugins.map(plugin => plugin.raw)
    const installedById = new Map(installedPlugins.map(plugin => [String(plugin.id), plugin]))
    setPluginMarketplaceState(previous => {
      const items = applyInstalledPluginsToMarketplaceItems(previous.items, installedRaw).map(
        item => {
          if (item.installedPluginId === null || item.installedPluginId === undefined) return item
          const installed = installedById.get(String(item.installedPluginId))
          if (!installed) return item
          const installedLocally =
            item.installedLocally ||
            hasLocalCodexMaterialization(installed.raw) ||
            !isCloudManagedInstalledPlugin(installed.raw)
          if (
            item.installed &&
            item.enabled === installed.enabled &&
            item.installedLocally === installedLocally
          ) {
            return item
          }
          return {
            ...item,
            installed: true,
            enabled: installed.enabled,
            installedLocally,
          }
        }
      )
      return sameMarketplaceItems(previous.items, items) ? previous : { ...previous, items }
    })
  }, [installedPlugins, setPluginMarketplaceState])
}
