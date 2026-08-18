import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { navigateTo } from '@/lib/navigation'
import { queuePluginPromptTrial } from '@/features/plugins/pluginTrial'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginMarketplaceState } from '../workspace/marketplaceWorkspaceHelpers'
import {
  findInstalledPluginForMarketplaceItem,
  localMarketplaceIdFromItem,
  resolveMarketplaceTrialPluginId,
  toMarketplaceInstalledPluginItem,
  tryPluginInChat,
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
    readInstalledPluginForTrial: (pluginId: string | number) => Promise<InstalledPlugin>
  }
  t: (key: string, defaultValue: string) => string
  setPluginMarketplaceState: Dispatch<SetStateAction<PluginMarketplaceState>>
}) {
  const tryLocalInstalledPluginInChat = useCallback(
    (pluginId: string | number, prompt?: string) => {
      localPluginApi
        .readInstalledPluginForTrial(pluginId)
        .then(plugin => {
          const queued = prompt
            ? queuePluginPromptTrial(plugin, prompt, { openInNewChat: true })
            : tryPluginInChat(plugin)
          if (prompt && queued) navigateTo('/')
          if (!queued) {
            setPluginMarketplaceState(previous => ({
              ...previous,
              error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
            }))
          }
        })
        .catch((error: Error) => {
          setPluginMarketplaceState(previous => ({
            ...previous,
            error: error.message,
          }))
        })
    },
    [localPluginApi, setPluginMarketplaceState, t]
  )

  const beginMarketplacePluginTrial = useCallback(
    (
      item: PluginMarketplaceItem,
      installed: InstalledPluginItem | null | undefined,
      prompt?: string
    ) => {
      const marketplaceId = localMarketplaceIdFromItem(item)
      if (marketplaceId) {
        localPluginApi.rememberMarketplaceSelection(marketplaceId)
        tryLocalInstalledPluginInChat(resolveMarketplaceTrialPluginId(item, installed), prompt)
        return
      }
      const trialPlugin = (installed ?? toMarketplaceInstalledPluginItem(item)).raw
      const queued = prompt
        ? queuePluginPromptTrial(trialPlugin, prompt, { openInNewChat: true })
        : tryPluginInChat(trialPlugin)
      if (prompt && queued) navigateTo('/')
      if (!queued) {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
        }))
      }
    },
    [localPluginApi, setPluginMarketplaceState, t, tryLocalInstalledPluginInChat]
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
    tryLocalInstalledPluginInChat,
    tryMarketplacePluginInChat,
  }
}
