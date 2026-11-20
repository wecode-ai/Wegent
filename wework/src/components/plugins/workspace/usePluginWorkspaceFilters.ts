import { useMarketplaceFilters } from '../hooks/useMarketplaceFilters'

export function usePluginWorkspaceFilters(input: Parameters<typeof useMarketplaceFilters>[0]) {
  const filters = useMarketplaceFilters(input)
  if (
    filters.marketplaceSourceFilterKey &&
    !filters.localMarketplaceTabs.some(item => item.key === filters.marketplaceSourceFilterKey)
  )
    filters.setMarketplaceSourceFilterKey('')
  return filters
}
