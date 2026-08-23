import { startTransition, useMemo, useState } from 'react'
import {
  marketplaceSearchScore,
  normalizeMarketplaceSearchQuery,
  rankMarketplaceSearchResults,
} from '@/features/plugins/marketplaceSearch'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  groupMarketplaceItemsAdaptively,
  prioritizeFeaturedMarketplaceItems,
} from '../marketplaceCategorySections'
import {
  installedPluginMarketplaceId,
  marketplacePluginDistribution,
  type PluginDistribution,
} from '../pluginDistribution'
import type { InstalledPluginItem } from '../PluginManagementRows'
import {
  INSTALLED_STRIP_VISIBLE_COUNT,
  MARKETPLACE_SEARCH_RESULT_BATCH_SIZE,
  isUserAddedMarketplace,
  localMarketplaceIdFromItem,
  type MarketplaceOption,
} from '../workspace/marketplaceWorkspaceHelpers'

export type MarketplaceDistributionTab = 'all' | PluginDistribution

export function useMarketplaceFilters({
  items,
  installedPlugins,
  marketplaces,
  isOpenAiOfficialCatalogLoading,
  hasMarketplace,
  t,
}: {
  items: PluginMarketplaceItem[]
  installedPlugins: InstalledPluginItem[]
  marketplaces: MarketplaceOption[]
  isOpenAiOfficialCatalogLoading: boolean
  hasMarketplace: boolean
  t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string
}) {
  const [query, setQuery] = useState('')
  const [searchResultWindow, setSearchResultWindow] = useState({ query: '', limit: 0 })
  const [selectedDistributionTab, setSelectedDistributionTab] =
    useState<MarketplaceDistributionTab>('all')
  const [marketplaceDistributionFilter, setMarketplaceDistributionFilter] =
    useState<MarketplaceDistributionTab>('all')
  const [marketplaceSourceFilterKey, setMarketplaceSourceFilterKey] = useState('')
  const [browsingCategoryKey, setBrowsingCategoryKey] = useState<string | null>(null)

  const marketplaceDistributionLabels = useMemo<Record<PluginDistribution, string>>(
    () => ({
      official: t('workbench.plugins_distribution_official', 'OpenAI官方'),
      workspace: t('workbench.plugins_distribution_workspace', '企业内部'),
      personal: t('workbench.plugins_distribution_personal', '个人创建'),
      public: t('workbench.plugins_distribution_public', 'Wework官方'),
      external: t('workbench.plugins_distribution_external', '第三方市场'),
    }),
    [t]
  )
  const localMarketplaceTabs = useMemo(
    () => marketplaces.filter(isUserAddedMarketplace),
    [marketplaces]
  )
  const normalizedQuery = normalizeMarketplaceSearchQuery(query)
  const visibleSearchResultLimit =
    searchResultWindow.query === normalizedQuery
      ? searchResultWindow.limit
      : MARKETPLACE_SEARCH_RESULT_BATCH_SIZE

  const visibleMarketplaceItems = useMemo(() => {
    const filteredItems = items.filter(item => {
      if (marketplaceSourceFilterKey) {
        const marketplaceId = marketplaceSourceFilterKey.slice('local:'.length)
        return localMarketplaceIdFromItem(item) === marketplaceId
      }
      return (
        marketplaceDistributionFilter === 'all' ||
        marketplacePluginDistribution(item) === marketplaceDistributionFilter
      )
    })
    return prioritizeFeaturedMarketplaceItems(
      rankMarketplaceSearchResults(filteredItems, normalizedQuery)
    )
  }, [items, marketplaceDistributionFilter, marketplaceSourceFilterKey, normalizedQuery])

  const marketplaceCategorySections = useMemo(() => {
    const openAiOfficialLabels = marketplaceDistributionFilter === 'official'
    return groupMarketplaceItemsAdaptively(
      visibleMarketplaceItems,
      {
        featured: 'Featured',
        other: openAiOfficialLabels ? 'Other' : t('workbench.plugins_category_other', '其他'),
        all: openAiOfficialLabels ? 'All plugins' : t('workbench.plugins_all', '全部插件'),
      },
      { forceFlat: Boolean(normalizedQuery) }
    )
  }, [marketplaceDistributionFilter, normalizedQuery, t, visibleMarketplaceItems])

  const isOpenAiOfficialViewLoading =
    marketplaceDistributionFilter === 'official' &&
    !marketplaceSourceFilterKey &&
    !normalizedQuery &&
    visibleMarketplaceItems.length === 0 &&
    isOpenAiOfficialCatalogLoading

  const browsingCategorySection = useMemo(
    () =>
      browsingCategoryKey
        ? (marketplaceCategorySections.find(section => section.key === browsingCategoryKey) ?? null)
        : null,
    [browsingCategoryKey, marketplaceCategorySections]
  )

  const visibleInstalledPlugins = useMemo(
    () =>
      installedPlugins.filter(plugin => {
        if (marketplaceSourceFilterKey) {
          const marketplaceId = marketplaceSourceFilterKey.slice('local:'.length)
          if (installedPluginMarketplaceId(plugin.raw) !== marketplaceId) return false
        }
        if (
          marketplaceDistributionFilter !== 'all' &&
          plugin.distribution !== marketplaceDistributionFilter
        ) {
          return false
        }
        if (!normalizedQuery) return true
        return (
          marketplaceSearchScore(
            {
              name: plugin.raw.spec.source.pluginKey,
              displayName: plugin.name,
              author: plugin.raw.spec.author,
              manifest: plugin.raw.spec.manifest,
              interface: plugin.raw.spec.interface,
            },
            normalizedQuery
          ) !== null
        )
      }),
    [installedPlugins, marketplaceDistributionFilter, marketplaceSourceFilterKey, normalizedQuery]
  )

  const installedStripPlugins = visibleInstalledPlugins.slice(0, INSTALLED_STRIP_VISIBLE_COUNT)
  const hiddenInstalledPlugins = visibleInstalledPlugins.slice(INSTALLED_STRIP_VISIBLE_COUNT)
  const showInstalledStrip =
    hasMarketplace && (!normalizedQuery || visibleInstalledPlugins.length > 0)

  const updateQuery = (next: string) => {
    setQuery(next)
    setBrowsingCategoryKey(null)
  }

  const selectDistributionTab = (distribution: MarketplaceDistributionTab) => {
    setMarketplaceSourceFilterKey('')
    setSelectedDistributionTab(distribution)
    setBrowsingCategoryKey(null)
    startTransition(() => {
      setMarketplaceDistributionFilter(distribution)
    })
  }

  const selectLocalMarketplaceTab = (marketplaceKey: string) => {
    setMarketplaceSourceFilterKey(marketplaceKey)
    setSelectedDistributionTab('all')
    setBrowsingCategoryKey(null)
    startTransition(() => {
      setMarketplaceDistributionFilter('all')
    })
  }

  const clearMarketplaceFilters = () => {
    setQuery('')
    setMarketplaceSourceFilterKey('')
    setSelectedDistributionTab('all')
    setBrowsingCategoryKey(null)
    startTransition(() => {
      setMarketplaceDistributionFilter('all')
    })
  }

  return {
    query,
    setQuery: updateQuery,
    searchResultWindow,
    setSearchResultWindow,
    selectedDistributionTab,
    marketplaceDistributionFilter,
    marketplaceSourceFilterKey,
    setMarketplaceSourceFilterKey,
    browsingCategoryKey,
    setBrowsingCategoryKey,
    marketplaceDistributionLabels,
    localMarketplaceTabs,
    normalizedQuery,
    visibleSearchResultLimit,
    visibleMarketplaceItems,
    marketplaceCategorySections,
    isOpenAiOfficialViewLoading,
    browsingCategorySection,
    visibleInstalledPlugins,
    installedStripPlugins,
    hiddenInstalledPlugins,
    showInstalledStrip,
    selectDistributionTab,
    selectLocalMarketplaceTab,
    clearMarketplaceFilters,
  }
}
