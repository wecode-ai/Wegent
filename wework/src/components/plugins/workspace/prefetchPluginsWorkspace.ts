/** Prefetch the plugins workspace chunks before the user opens the page. */
export function prefetchPluginsWorkspace(): void {
  void import('@/components/plugins/PluginsWorkspace')
  void import('@/components/plugins/workspace/MarketplaceCatalogView')
  void import('@/components/plugins/PluginDetailView')
}
