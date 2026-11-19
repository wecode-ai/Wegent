import { ExpiredPluginInventoryRequest } from '@/api/local/codexInstalledCatalog'
import { getPluginMarketplaceCache } from '@/features/plugins/pluginMarketplaceCache'
import { pluginInstallationReadIsCurrent } from '@/features/plugins/pluginInventory'
import { sameLocalPluginSources } from '@/features/plugins/pluginInventorySources'
import { hasInFlightPluginDeviceSync } from '@/features/plugins/pluginDeviceAutoSync'
import type { PluginCatalogContext } from './pluginCatalogState'
export function reconcileLocalPluginCatalog(ctx: PluginCatalogContext) {
  const owner = ctx.epoch
  if (ctx.state.catalogReadReadyKey !== `${ctx.key}:${ctx.state.marketplaceRefreshTick}`) return
  if (ctx.state.personalDiskSettledKey !== ctx.key) return
  if (ctx.pendingDevicePackageSync) return
  // A sync effect earlier in this commit can acquire the lock before React
  // publishes its new snapshot. Recheck the live lock; the subscription resumes
  // reconciliation after release even if catalog/connection hints changed.
  if (hasInFlightPluginDeviceSync(ctx.state.currentDeviceId)) return
  const skipLocalCatalogReconcile = ctx.ledger.skipLocalCatalogReconcile
  ctx.ledger.skipLocalCatalogReconcile = false
  if (skipLocalCatalogReconcile) {
    ctx.ledger.deferredCodexCatalogRequest = `${ctx.key}:${ctx.state.marketplaceRefreshTick}`
    ctx.publish({ isMarketplaceRefreshing: false })
    return
  }
  const requestKey = `${ctx.key}:${ctx.state.marketplaceRefreshTick}`
  if (ctx.ledger.deferredCodexCatalogRequest === requestKey) return
  ctx.ledger.deferredCodexCatalogRequest = requestKey
  const inventoryAtStart = getPluginMarketplaceCache(ctx.key)
  let cancelled = false
  const isActiveRequest = () =>
    !cancelled &&
    owner !== null &&
    ctx.epoch === owner &&
    ctx.ledger.deferredCodexCatalogRequest === requestKey
  const isCurrent = () =>
    isActiveRequest() &&
    pluginInstallationReadIsCurrent(ctx.key, inventoryAtStart) &&
    sameLocalPluginSources(getPluginMarketplaceCache(ctx.key), inventoryAtStart)
  void ctx.input.localPluginApi
    .readState({
      mergeAllMarketplaces: true,
      marketplaceKinds: ['local'],
      refresh: true,
      reuseInstalledInventory: true,
    })
    .then(localState => {
      const trace = (reason: string) => {
        if (import.meta.env.VITE_WEWORK_E2E === 'true')
          console.info('[plugin-catalog-publication]', reason)
      }
      if (!isCurrent()) {
        trace('superseded')
        return
      }
      if (localState.partial) {
        ctx.publish({ inventoryComplete: false })
        ctx.publish({ localInstalledStateReadyKey: null })
        ctx.publish({
          pluginOperationNotice: {
            id: 'plugin-catalog-load',
            kind: 'error',
            message: ctx.input.t('workbench.plugins_load_failed', '加载插件失败'),
          },
        })
      }
      trace('applying')
      ctx.applyLiveCodexCatalog(localState)
    })
    .catch(error => {
      if (!isCurrent() || error instanceof ExpiredPluginInventoryRequest) return
      ctx.publish({
        marketplaceCatalogState: (previous => ({ ...previous, isLoading: false }))(
          ctx.state.marketplaceCatalogState
        ),
      })
      ctx.publish({
        pluginOperationNotice: {
          id: 'plugin-catalog-load',
          kind: 'error',
          message: ctx.input.t('workbench.plugins_load_failed', '加载插件失败'),
        },
      })
    })
    .finally(() => {
      if (isActiveRequest()) ctx.publish({ isMarketplaceRefreshing: false })
    })
  return () => {
    cancelled = true
    if (ctx.ledger.deferredCodexCatalogRequest === requestKey) {
      ctx.ledger.deferredCodexCatalogRequest = ''
    }
  }
}
