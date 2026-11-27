import {
  cloudMarketplaceKey,
  localMarketplaceKey,
  toMarketplaceOptions,
} from '../workspace/marketplaceWorkspaceHelpers'

import type { PluginCatalogContext } from './pluginCatalogState'

export function applyLocalPluginCatalogOptions(
  ctx: PluginCatalogContext,
  state: Awaited<ReturnType<typeof ctx.input.localPluginApi.readState>>
) {
  const options = toMarketplaceOptions(
    state.marketplaces,
    ctx.input.cloudMarketplaceAvailable,
    ctx.input.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
  )
  ctx.publish({ marketplaces: options })
  ctx.publish({
    selectedMarketplaceKey: (current => {
      // Prefer the cloud marketplace as the default.
      if (ctx.input.cloudMarketplaceAvailable && !current) {
        return cloudMarketplaceKey()
      }
      // Preserve an existing explicit marketplace selection.
      if (current && options.some(marketplace => marketplace.key === current)) {
        return current
      }
      // Restore the saved marketplace while it remains available.
      const selectedKey = state.selectedMarketplaceId
        ? localMarketplaceKey(state.selectedMarketplaceId)
        : ''
      if (selectedKey && options.some(marketplace => marketplace.key === selectedKey)) {
        return selectedKey
      }
      // Fall back to the cloud marketplace or the first local marketplace.
      if (ctx.input.cloudMarketplaceAvailable) return cloudMarketplaceKey()
      return options[0]?.key || ''
    })(ctx.state.selectedMarketplaceKey),
  })
}
