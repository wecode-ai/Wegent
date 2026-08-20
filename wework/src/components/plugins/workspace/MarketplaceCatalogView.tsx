import { memo, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { Boxes, RefreshCw } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  MarketplaceSearchInput,
  type MarketplaceSearchInputHandle,
} from '../MarketplaceSearchInput'
import {
  previewMarketplaceSectionItems,
  type MarketplaceCategorySection,
} from '../marketplaceCategorySections'
import type { PluginDistribution } from '../pluginDistribution'
import {
  MARKETPLACE_SECTION_PREVIEW_COUNT,
  marketplaceSectionRevealLabel,
  type MarketplaceOption,
} from './marketplaceWorkspaceHelpers'
import { PluginMarketplaceLoadingSkeleton } from './PluginMarketplaceLoadingSkeleton'
import {
  PluginMarketplaceRow,
  type PluginMarketplaceRowAction,
  type PluginMarketplaceRowLabels,
} from './PluginMarketplaceRow'
import { PluginMarketplaceRevealButton } from './PluginMarketplaceRevealButton'

const SEARCH_VIRTUALIZE_THRESHOLD = 40
const SEARCH_ROW_ESTIMATE_PX = 78
const SEARCH_GRID_BREAKPOINT_PX = 1050

function VirtualizedSearchGrid({
  items,
  isLoggedIn,
  installingMarketplacePluginIds,
  uninstallingPluginIds,
  allowPendingRetry,
  showPendingAsSyncing,
  rowLabels,
  onAction,
}: {
  items: PluginMarketplaceItem[]
  isLoggedIn: boolean
  installingMarketplacePluginIds: Set<string | number>
  uninstallingPluginIds: Set<string | number>
  allowPendingRetry: boolean
  showPendingAsSyncing: boolean
  rowLabels: PluginMarketplaceRowLabels
  onAction: (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const columnCount =
    typeof window === 'undefined' || window.innerWidth > SEARCH_GRID_BREAKPOINT_PX ? 2 : 1
  const rowCount = Math.max(1, Math.ceil(items.length / columnCount))
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => listRef.current,
    estimateSize: () => SEARCH_ROW_ESTIMATE_PX,
    overscan: 8,
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement
      if (!element) return
      const emit = () => {
        const rect = element.getBoundingClientRect()
        callback({
          width: Math.max(rect.width, 720),
          height: Math.max(rect.height, 560),
        })
      }
      emit()
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(emit)
      observer?.observe(element)
      window.addEventListener('resize', emit)
      return () => {
        observer?.disconnect()
        window.removeEventListener('resize', emit)
      }
    },
  })
  const virtualRows = virtualizer.getVirtualItems()

  return (
    <div ref={listRef} className="relative min-h-[240px]">
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualRows.map(row => {
          const rowItems = items.slice(
            row.index * columnCount,
            row.index * columnCount + columnCount
          )
          return (
            <div
              key={row.key}
              className="plugin-market-card-grid absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {rowItems.map(item => (
                <PluginMarketplaceRow
                  key={item.id}
                  item={item}
                  isLoggedIn={isLoggedIn}
                  isInstalling={installingMarketplacePluginIds.has(item.id)}
                  isUninstalling={uninstallingPluginIds.has(item.installedPluginId ?? item.id)}
                  allowPendingRetry={allowPendingRetry}
                  showPendingAsSyncing={showPendingAsSyncing}
                  labels={rowLabels}
                  onAction={onAction}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MarketplaceCardGrid({
  items,
  isLoggedIn,
  installingMarketplacePluginIds,
  uninstallingPluginIds,
  allowPendingRetry,
  showPendingAsSyncing,
  rowLabels,
  onAction,
}: {
  items: PluginMarketplaceItem[]
  isLoggedIn: boolean
  installingMarketplacePluginIds: Set<string | number>
  uninstallingPluginIds: Set<string | number>
  allowPendingRetry: boolean
  showPendingAsSyncing: boolean
  rowLabels: PluginMarketplaceRowLabels
  onAction: (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => void
}) {
  if (items.length > SEARCH_VIRTUALIZE_THRESHOLD) {
    return (
      <VirtualizedSearchGrid
        items={items}
        isLoggedIn={isLoggedIn}
        installingMarketplacePluginIds={installingMarketplacePluginIds}
        uninstallingPluginIds={uninstallingPluginIds}
        allowPendingRetry={allowPendingRetry}
        showPendingAsSyncing={showPendingAsSyncing}
        rowLabels={rowLabels}
        onAction={onAction}
      />
    )
  }
  return (
    <div className="plugin-market-card-grid">
      {items.map(item => (
        <PluginMarketplaceRow
          key={item.id}
          item={item}
          isLoggedIn={isLoggedIn}
          isInstalling={installingMarketplacePluginIds.has(item.id)}
          isUninstalling={uninstallingPluginIds.has(item.installedPluginId ?? item.id)}
          allowPendingRetry={allowPendingRetry}
          showPendingAsSyncing={showPendingAsSyncing}
          labels={rowLabels}
          onAction={onAction}
        />
      ))}
    </div>
  )
}

export const MarketplaceCatalogView = memo(function MarketplaceCatalogView({
  hasMarketplace,
  marketplaces,
  selectedMarketplaceKey,
  selectedDistributionTab,
  marketplaceSourceFilterKey,
  marketplaceDistributionLabels,
  localMarketplaceTabs,
  query,
  searchInputRef,
  scrollRef,
  installedStrip,
  showInstalledStrip,
  pluginMarketplaceState,
  marketplaceLoadingMessage,
  isMarketplaceRefreshing,
  isMarketplaceSearchUpdating,
  isOpenAiOfficialViewLoading,
  normalizedQuery,
  visibleMarketplaceItems,
  marketplaceCategorySections,
  visibleSearchResultLimit,
  isLoggedIn,
  installingMarketplacePluginIds,
  uninstallingPluginIds,
  allowPendingRetry,
  showPendingAsSyncing,
  rowLabels,
  onSelectDistributionTab,
  onSelectLocalMarketplaceTab,
  onQueryChange,
  onRefresh,
  onClearFilters,
  onRevealMore,
  onAction,
}: {
  hasMarketplace: boolean
  marketplaces: MarketplaceOption[]
  selectedMarketplaceKey: string
  selectedDistributionTab: 'all' | PluginDistribution
  marketplaceSourceFilterKey: string
  marketplaceDistributionLabels: Record<PluginDistribution, string>
  localMarketplaceTabs: MarketplaceOption[]
  query: string
  searchInputRef: RefObject<MarketplaceSearchInputHandle | null>
  scrollRef: RefObject<HTMLDivElement | null>
  installedStrip: ReactNode
  showInstalledStrip: boolean
  pluginMarketplaceState: {
    items: PluginMarketplaceItem[]
    isLoading: boolean
    error: string | null
  }
  marketplaceLoadingMessage: string
  isMarketplaceRefreshing: boolean
  isMarketplaceSearchUpdating: boolean
  isOpenAiOfficialViewLoading: boolean
  normalizedQuery: string
  visibleMarketplaceItems: PluginMarketplaceItem[]
  marketplaceCategorySections: MarketplaceCategorySection[]
  visibleSearchResultLimit: number
  isLoggedIn: boolean
  installingMarketplacePluginIds: Set<string | number>
  uninstallingPluginIds: Set<string | number>
  allowPendingRetry: boolean
  showPendingAsSyncing: boolean
  rowLabels: PluginMarketplaceRowLabels
  onSelectDistributionTab: (distribution: 'all' | PluginDistribution) => void
  onSelectLocalMarketplaceTab: (marketplace: MarketplaceOption) => void
  onQueryChange: (query: string) => void
  onRefresh: () => void
  onClearFilters: () => void
  onRevealMore: (section: MarketplaceCategorySection) => void
  onAction: (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => void
}) {
  const { t } = useTranslation('common')
  const distributionTabs = useMemo(
    () =>
      [
        ['all', t('workbench.plugins_distribution_all', '全部')],
        ['official', marketplaceDistributionLabels.official],
        ['public', marketplaceDistributionLabels.public],
        ['workspace', marketplaceDistributionLabels.workspace],
        ['personal', marketplaceDistributionLabels.personal],
      ] as const,
    [marketplaceDistributionLabels, t]
  )

  return (
    <>
      {hasMarketplace && (
        <div className="plugin-market-body">
          <div
            className="plugin-market-toolbar flex flex-col gap-3 md:flex-row md:items-center md:gap-3"
            data-testid="plugins-market-toolbar"
          >
            <div
              className="flex min-w-0 flex-1 gap-[7px] overflow-x-auto"
              role="tablist"
              aria-label={t('workbench.plugins_distribution_filter', '插件类型')}
            >
              {distributionTabs.map(([distribution, label]) => (
                <button
                  key={distribution}
                  type="button"
                  role="tab"
                  aria-selected={
                    !marketplaceSourceFilterKey && selectedDistributionTab === distribution
                  }
                  data-testid={`plugins-distribution-tab-${distribution}`}
                  className="plugin-market-filter"
                  onClick={() => onSelectDistributionTab(distribution)}
                >
                  {label}
                </button>
              ))}
              {localMarketplaceTabs.map(marketplace => (
                <button
                  key={marketplace.key}
                  type="button"
                  role="tab"
                  aria-selected={marketplace.key === marketplaceSourceFilterKey}
                  data-testid={`plugins-marketplace-tab-${marketplace.id}`}
                  className={[
                    'plugin-market-filter',
                    marketplace.key === marketplaceSourceFilterKey ? 'bg-surface' : '',
                  ].join(' ')}
                  onClick={() => onSelectLocalMarketplaceTab(marketplace)}
                >
                  {marketplace.name}
                </button>
              ))}
            </div>
            <div
              className="sr-only"
              aria-hidden="true"
              data-testid="plugins-marketplace-source-switcher"
            >
              {marketplaces
                .filter(marketplace => marketplace.kind === 'cloud')
                .map(marketplace => (
                  <span
                    key={marketplace.key}
                    data-testid={`plugins-marketplace-tab-${marketplace.id}`}
                    className={marketplace.key === selectedMarketplaceKey ? 'bg-surface' : ''}
                  >
                    {marketplace.name}
                  </span>
                ))}
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 md:w-auto">
              <MarketplaceSearchInput
                ref={searchInputRef}
                initialValue={query}
                label={t('workbench.plugins_search_plugins', '搜索插件')}
                placeholder={t('workbench.plugins_marketplace_search', '搜索插件')}
                clearLabel={t('workbench.plugins_clear_search', '清空搜索')}
                onQueryChange={onQueryChange}
              />
            </div>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        data-testid="plugins-market-scroll-region"
        className="plugin-market-scroll-region min-h-0 flex-1 overflow-y-auto pb-14"
      >
        {installedStrip}
        <section
          className={[
            'plugin-market-catalog',
            showInstalledStrip ? 'plugin-market-catalog-after-strip' : '',
          ].join(' ')}
        >
          {pluginMarketplaceState.isLoading && pluginMarketplaceState.items.length === 0 ? (
            <PluginMarketplaceLoadingSkeleton
              message={
                marketplaceLoadingMessage ||
                t('workbench.plugins_loading_marketplace', '正在加载插件市场')
              }
              hint={
                marketplaces.some(
                  entry =>
                    entry.kind === 'local' && /^https?:\/\/github\.com\//i.test(entry.path || '')
                )
                  ? t(
                      'workbench.plugins_github_clone_hint',
                      '这个过程会在本地缓存仓库，完成后再次打开会直接读取缓存。'
                    )
                  : undefined
              }
            />
          ) : pluginMarketplaceState.error && pluginMarketplaceState.items.length === 0 ? (
            <div
              data-testid="plugins-marketplace-error"
              className="flex min-h-[180px] items-center justify-center text-sm font-semibold text-text-secondary"
            >
              {pluginMarketplaceState.error}
            </div>
          ) : marketplaces.length === 0 &&
            !pluginMarketplaceState.isLoading &&
            !isMarketplaceRefreshing ? (
            <div
              data-testid="plugins-cloud-marketplace-unavailable"
              className="flex min-h-[220px] flex-col items-center justify-center gap-2 border-t border-border text-center"
            >
              <Boxes className="h-8 w-8 text-text-muted" />
              <h2 className="text-base font-medium text-text-primary">
                {t('workbench.plugins_cloud_marketplace_unavailable', '云端插件市场暂不可用')}
              </h2>
              <p className="text-sm text-text-muted">
                {t(
                  'workbench.plugins_cloud_marketplace_unavailable_hint',
                  '请检查 Wework 云端连接后重试。'
                )}
              </p>
            </div>
          ) : visibleMarketplaceItems.length === 0 &&
            (pluginMarketplaceState.isLoading ||
              isMarketplaceRefreshing ||
              isOpenAiOfficialViewLoading) &&
            !normalizedQuery ? (
            <PluginMarketplaceLoadingSkeleton
              message={
                marketplaceLoadingMessage ||
                t('workbench.plugins_refreshing_marketplace', '正在刷新插件市场')
              }
            />
          ) : visibleMarketplaceItems.length === 0 ? (
            selectedDistributionTab === 'official' &&
            !marketplaceSourceFilterKey &&
            !normalizedQuery &&
            !pluginMarketplaceState.isLoading &&
            !isMarketplaceRefreshing ? (
              <div
                data-testid="plugins-openai-official-empty"
                className="flex min-h-[160px] flex-col items-start justify-center gap-2 text-sm"
              >
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.plugins_openai_official_empty', 'OpenAI 官方市场暂无可用插件')}
                </h2>
                <p className="text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.plugins_openai_official_empty_hint',
                    '首次打开需要从 GitHub 同步 openai/plugins。请检查网络后刷新重试。'
                  )}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="plugins-openai-official-empty-refresh"
                    className="h-8 rounded-[10px] bg-text-primary px-3 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={pluginMarketplaceState.isLoading || isMarketplaceRefreshing}
                    onClick={onRefresh}
                  >
                    {t('workbench.plugins_openai_official_empty_refresh', '刷新并重试')}
                  </button>
                  <button
                    type="button"
                    data-testid="plugins-clear-marketplace-filters"
                    className="h-8 rounded-[10px] border border-border/30 bg-surface px-3 text-xs font-medium text-text-primary transition-colors hover:bg-muted"
                    onClick={onClearFilters}
                  >
                    {t('workbench.plugins_view_all', '查看全部')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[160px] flex-col items-start justify-center gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-text-primary">
                    {t('workbench.plugins_no_marketplace_results', '没有匹配的插件')}
                  </h2>
                  {normalizedQuery && (
                    <span
                      className="plugin-market-search-status"
                      role="status"
                      aria-live="polite"
                      data-testid="plugins-search-result-count"
                    >
                      {isMarketplaceSearchUpdating && (
                        <RefreshCw className="animate-spin" aria-hidden="true" />
                      )}
                      {t('workbench.plugins_search_results_count', '{{count}} 个匹配结果', {
                        count: 0,
                      })}
                    </span>
                  )}
                </div>
                <p className="text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.plugins_no_marketplace_results_hint',
                    '可以清除搜索和分类后重新浏览。'
                  )}
                </p>
                <button
                  type="button"
                  data-testid="plugins-clear-marketplace-filters"
                  className="mt-1 h-8 rounded-[10px] border border-border/30 bg-surface px-3 text-xs font-medium text-text-primary transition-colors hover:bg-muted"
                  onClick={onClearFilters}
                >
                  {t('workbench.plugins_view_all', '查看全部')}
                </button>
              </div>
            )
          ) : (
            <div className="plugin-market-category-sections" data-testid="plugins-all-section">
              {marketplaceCategorySections.map(section => {
                const { preview, rest } = previewMarketplaceSectionItems(
                  section.items,
                  section.flat
                    ? normalizedQuery
                      ? visibleSearchResultLimit
                      : section.items.length
                    : MARKETPLACE_SECTION_PREVIEW_COUNT
                )
                return (
                  <section
                    key={section.key}
                    data-testid={`plugins-category-section-${section.key}`}
                    className="plugin-market-category-section"
                  >
                    {!section.flat && (
                      <div className="plugin-market-section-head">
                        <h2>{section.title}</h2>
                      </div>
                    )}
                    <MarketplaceCardGrid
                      items={preview}
                      isLoggedIn={isLoggedIn}
                      installingMarketplacePluginIds={installingMarketplacePluginIds}
                      uninstallingPluginIds={uninstallingPluginIds}
                      allowPendingRetry={allowPendingRetry}
                      showPendingAsSyncing={showPendingAsSyncing}
                      rowLabels={rowLabels}
                      onAction={onAction}
                    />
                    {rest.length > 0 && (
                      <PluginMarketplaceRevealButton
                        items={rest}
                        label={marketplaceSectionRevealLabel(rest, t)}
                        testId={`plugins-category-more-${section.key}`}
                        onReveal={() => onRevealMore(section)}
                      />
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </>
  )
})
