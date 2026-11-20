import { useCallback } from 'react'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import {
  findInstalledPluginForMarketplaceItem,
  queueMarketplacePluginTrial,
} from '../workspace/marketplaceWorkspaceHelpers'

export function usePluginInstallActions({
  installedPlugins,
  localPluginApi,
  isUninstalling,
  t,
  reportCatalogError,
}: {
  installedPlugins: InstalledPluginItem[]
  isUninstalling: (item: PluginMarketplaceItem) => boolean
  localPluginApi: {
    rememberMarketplaceSelection: (marketplaceId: string) => void
  }
  t: (key: string, defaultValue: string) => string
  reportCatalogError(message: string): void
}) {
  const beginMarketplacePluginTrial = useCallback(
    (
      item: PluginMarketplaceItem,
      installed: InstalledPluginItem | null | undefined,
      prompt?: string
    ) => {
      if (isUninstalling(item)) return
      const queued = queueMarketplacePluginTrial({
        item,
        installed,
        prompt,
        rememberMarketplaceSelection: marketplaceId =>
          localPluginApi.rememberMarketplaceSelection(marketplaceId),
      })
      if (!queued) {
        reportCatalogError(t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'))
      }
    },
    [isUninstalling, localPluginApi, reportCatalogError, t]
  )

  const tryMarketplacePluginInChat = useCallback(
    (item: PluginMarketplaceItem) => {
      const installed = findInstalledPluginForMarketplaceItem(item, installedPlugins)
      beginMarketplacePluginTrial(item, installed)
    },
    [beginMarketplacePluginTrial, installedPlugins]
  )

  return {
    beginMarketplacePluginTrial,
    tryMarketplacePluginInChat,
  }
}
