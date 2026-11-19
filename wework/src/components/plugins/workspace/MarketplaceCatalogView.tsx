import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginMarketplaceItem } from '@/types/api'
import { SegmentedControl } from '@wegent/collaboration/controls/SegmentedControl'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Boxes, RefreshCw } from 'lucide-react'
import type { ReactNode, Ref, RefObject } from 'react'
import { memo, useMemo } from 'react'
import type { MarketplaceCategorySection } from '../marketplaceCategorySections'
import { previewMarketplaceSectionItems } from '../marketplaceCategorySections'
import type { MarketplaceSearchInputHandle } from '../MarketplaceSearchInput'
import { MarketplaceSearchInput } from '../MarketplaceSearchInput'
import type { PluginDistribution } from '../pluginDistribution'
import { MarketplaceCardGrid } from './MarketplaceCardGrid'
import type { MarketplaceOption } from './marketplaceWorkspaceHelpers'
import {
  MARKETPLACE_SECTION_PREVIEW_COUNT,
  marketplaceSectionRevealLabel,
} from './marketplaceWorkspaceHelpers'
import { PluginMarketplaceLoadingSkeleton } from './PluginMarketplaceLoadingSkeleton'
import { PluginMarketplaceRevealButton } from './PluginMarketplaceRevealButton'
import type { OpenAiPluginCatalogError } from '@/features/plugins/useOpenAiPluginCatalog'
import type { PluginMarketplaceRowAction, PluginMarketplaceRowLabels } from './PluginMarketplaceRow'

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
  pluginMarketplaceState: sourceMarketplaceState,
  marketplaceLoadingMessage,
  isMarketplaceRefreshing: sourceMarketplaceRefreshing,
  isMarketplaceSearchUpdating,
  isOpenAiOfficialViewLoading,
  openAiCatalogError,
  isOpenAiCatalogRefreshing = false,
  normalizedQuery,
  visibleMarketplaceItems,
  marketplaceCategorySections,
  visibleSearchResultLimit,
  isLoggedIn,
  isReconciling,
  installingMarketplacePluginIds,
  isLocallyUninstalling,
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
  scrollRef: Ref<HTMLDivElement>
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
  openAiCatalogError?: OpenAiPluginCatalogError | null
  isOpenAiCatalogRefreshing?: boolean
  normalizedQuery: string
  visibleMarketplaceItems: PluginMarketplaceItem[]
  marketplaceCategorySections: MarketplaceCategorySection[]
  visibleSearchResultLimit: number
  isLoggedIn: boolean
  isReconciling: boolean
  installingMarketplacePluginIds: Set<string | number>
  isLocallyUninstalling: (item: PluginMarketplaceItem) => boolean
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
  const isOfficialView = selectedDistributionTab === 'official' && !marketplaceSourceFilterKey
  const pluginMarketplaceState = isOfficialView
    ? { ...sourceMarketplaceState, isLoading: isOpenAiOfficialViewLoading, error: null }
    : sourceMarketplaceState
  const isMarketplaceRefreshing = isOfficialView
    ? isOpenAiCatalogRefreshing
    : sourceMarketplaceRefreshing
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
            className="plugin-market-toolbar flex flex-col gap-3"
            data-testid="plugins-market-toolbar"
          >
            <div className="min-w-0 flex-1 overflow-x-auto">
              <SegmentedControl
                label={t('workbench.plugins_distribution_filter', '插件类型')}
                value={
                  marketplaceSourceFilterKey
                    ? JSON.stringify(['marketplace', marketplaceSourceFilterKey])
                    : JSON.stringify(['distribution', selectedDistributionTab])
                }
                options={[
                  ...distributionTabs.map(([distribution, label]) => ({
                    value: JSON.stringify(['distribution', distribution]),
                    label,
                    testId: 'plugins-distribution-tab-' + distribution,
                  })),
                  ...localMarketplaceTabs.map(marketplace => ({
                    value: JSON.stringify(['marketplace', marketplace.key]),
                    label: marketplace.name,
                    testId: 'plugins-marketplace-tab-' + marketplace.id,
                  })),
                ]}
                onChange={value => {
                  const distribution = distributionTabs.find(
                    ([key]) => JSON.stringify(['distribution', key]) === value
                  )
                  if (distribution) {
                    onSelectDistributionTab(distribution[0])
                    return
                  }
                  const marketplace = localMarketplaceTabs.find(
                    item => JSON.stringify(['marketplace', item.key]) === value
                  )
                  if (marketplace) onSelectLocalMarketplaceTab(marketplace)
                }}
                className="w-max min-w-full"
              />
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
            <div className="plugin-market-toolbar-search flex w-full shrink-0 items-center gap-2">
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
        data-plugin-market-scroll-region=""
        data-testid="plugins-market-scroll-region"
        className="plugin-market-scroll-region min-h-0 flex-1 overflow-y-auto pb-14"
      >
        {installedStrip}
        {isOfficialView && openAiCatalogError && (
          <div
            role="alert"
            data-testid="plugins-openai-catalog-error"
            className="mb-3 flex items-center gap-2 text-sm text-text-secondary"
          >
            <span>{t(`workbench.plugins_openai_catalog_${openAiCatalogError}`)}</span>
            <Button
              variant="outline"
              size="sm"
              data-testid="plugins-openai-catalog-retry"
              onClick={onRefresh}
              disabled={isOpenAiCatalogRefreshing}
            >
              {t('workbench.plugins_openai_official_empty_refresh', '刷新并重试')}
            </Button>
          </div>
        )}
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
          ) : !isOfficialView &&
            marketplaces.length === 0 &&
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
          ) : isOfficialView &&
            openAiCatalogError &&
            visibleMarketplaceItems.length === 0 ? null : visibleMarketplaceItems.length === 0 ? (
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
                    '暂未获取到远程目录，请检查 Codex 登录和网络连接后重试。'
                  )}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <ControlButton
                    variant="primary"
                    size="sm"
                    type="button"
                    data-testid="plugins-openai-official-empty-refresh"
                    className="h-8 rounded-[10px] bg-text-primary px-3 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={pluginMarketplaceState.isLoading || isMarketplaceRefreshing}
                    onClick={onRefresh}
                  >
                    {t('workbench.plugins_openai_official_empty_refresh', '刷新并重试')}
                  </ControlButton>
                  <ControlButton
                    variant="outline"
                    size="sm"
                    type="button"
                    data-testid="plugins-clear-marketplace-filters"
                    className="h-8 rounded-[10px] border border-border/30 bg-surface px-3 text-xs font-medium text-text-primary transition-colors hover:bg-muted"
                    onClick={onClearFilters}
                  >
                    {t('workbench.plugins_view_all', '查看全部')}
                  </ControlButton>
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
                <ControlButton
                  variant="outline"
                  size="sm"
                  type="button"
                  data-testid="plugins-clear-marketplace-filters"
                  className="mt-1 h-8 rounded-[10px] border border-border/30 bg-surface px-3 text-xs font-medium text-text-primary transition-colors hover:bg-muted"
                  onClick={onClearFilters}
                >
                  {t('workbench.plugins_view_all', '查看全部')}
                </ControlButton>
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
                      isReconciling={isReconciling}
                      installingMarketplacePluginIds={installingMarketplacePluginIds}
                      isLocallyUninstalling={isLocallyUninstalling}
                      allowPendingRetry={allowPendingRetry}
                      showPendingAsSyncing={showPendingAsSyncing}
                      labels={rowLabels}
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
