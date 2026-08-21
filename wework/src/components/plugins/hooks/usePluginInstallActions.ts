import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginMarketplaceState } from '../workspace/marketplaceWorkspaceHelpers'
import {
  findInstalledPluginForMarketplaceItem,
  queueMarketplacePluginTrial,
} from '../workspace/marketplaceWorkspaceHelpers'

export function usePluginInstallActions({
  installedPlugins,
  localPluginApi,
  t,
  setPluginMarketplaceState,
}: {
  installedPlugins: InstalledPluginItem[]
  localPluginApi: {
    rememberMarketplaceSelection: (marketplaceId: string) => void
  }
  t: (key: string, defaultValue: string) => string
  setPluginMarketplaceState: Dispatch<SetStateAction<PluginMarketplaceState>>
}) {
  const beginMarketplacePluginTrial = useCallback(
    (
      item: PluginMarketplaceItem,
      installed: InstalledPluginItem | null | undefined,
      prompt?: string
    ) => {
      const queued = queueMarketplacePluginTrial({
        item,
        installed,
        prompt,
        rememberMarketplaceSelection: marketplaceId =>
          localPluginApi.rememberMarketplaceSelection(marketplaceId),
      })
      if (!queued) {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
        }))
      }
    },
    [localPluginApi, setPluginMarketplaceState, t]
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
