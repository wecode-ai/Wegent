import { PluginReconciliationStatus } from '../PluginReconciliationStatus'
import { RefreshCw, Settings2 } from 'lucide-react'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { navigateTo } from '@/lib/navigation'
import { InstalledPluginStrip } from '../workspace/InstalledPluginStrip'
import { MarketplaceCatalogView } from '../workspace/MarketplaceCatalogView'
import { PluginCreateMenu } from '../PluginCreateMenu'
import { AddMarketDialog } from '../workspace/AddMarketDialog'
import { CategoryBrowseDialog } from '../workspace/CategoryBrowseDialog'
import type { PluginsWorkspaceViewContext } from './pluginWorkspaceViewContext'

export function renderPluginCatalogWorkspace({
  sidebarCollapsed,
  topBarLeftActions,
  t,
  isReconcilingPlugins,
  localSyncAvailable,
  pluginMarketplaceState,
  isMarketplaceRefreshing,
  openAiCatalog,
  isOfficialCatalogView,
  reconciliationRevision,
  isCatalogRefreshBusy,
  refreshMarketplace,
  isCreateMenuOpen,
  setIsCreateMenuOpen,
  openPluginCreator,
  setShowPluginImportDialog,
  setShowAddMarketDialog,
  reconciliation,
  hasMarketplace,
  marketplaces,
  selectedMarketplaceKey,
  selectedDistributionTab,
  marketplaceSourceFilterKey,
  marketplaceDistributionLabels,
  localMarketplaceTabs,
  query,
  marketplaceSearchInputRef,
  bindMarketplaceViewport,
  showInstalledStrip,
  installedStripPlugins,
  hiddenInstalledPlugins,
  openInstalledPluginDetail,
  marketplaceLoadingMessage,
  isMarketplaceSearchUpdating,
  isOpenAiOfficialViewLoading,
  normalizedQuery,
  visibleMarketplaceItems,
  marketplaceCategorySections,
  visibleSearchResultLimit,
  cloudToken,
  currentDeviceId,
  reconciliationBlocksActions,
  installingMarketplacePluginIds,
  isMarketplacePluginLocallyUninstalling,
  deviceAutoSyncSettled,
  deviceCloudConnected,
  localInventoryReady,
  marketplaceRowLabels,
  handleSelectDistributionTab,
  handleSelectLocalMarketplaceTab,
  setQuery,
  handleClearMarketplaceFilters,
  handleRevealMore,
  handleMarketplaceRowAction,
  pluginOverlayDialogs,
  pluginOperationNoticeOverlay,
  browsingCategorySection,
  setBrowsingCategoryKey,
  showAddMarketDialog,
  isAddingMarket,
  addMarketForm,
  setAddMarketForm,
  addMarketplace,
  pluginShareDialog,
  pluginPublishDialog,
}: PluginsWorkspaceViewContext) {
  return (
    <main
      data-testid="plugins-workspace"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background text-text-primary"
    >
      <div
        data-testid="plugins-page-content"
        className={[
          'mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col px-5 md:px-10',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          topBarLeftActions ? 'pt-3 md:pt-4' : 'pt-6 md:pt-7',
        ].join(' ')}
      >
        {topBarLeftActions ? (
          <div className="mb-3 flex min-h-8 items-center gap-2 md:mb-4">
            <div data-testid="plugins-topbar-left-actions" className="shrink-0">
              {topBarLeftActions}
            </div>
            <div
              data-testid="plugins-topbar-drag-region"
              className="min-h-8 min-w-0 flex-1 self-stretch"
            >
              <MacOSTitleBarDragRegion className="h-full w-full" />
            </div>
          </div>
        ) : null}

        <header
          data-testid="plugins-topbar"
          className="plugin-market-header relative flex items-start justify-between gap-6"
        >
          {!topBarLeftActions ? (
            <div
              data-testid="plugins-topbar-drag-region"
              className="pointer-events-none absolute inset-x-0 top-0 hidden min-h-[52px] md:block"
              aria-hidden="true"
            >
              <MacOSTitleBarDragRegion className="h-full w-full" />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="sr-only">{t('workbench.plugin_management_tab_plugins', '插件')}</h2>
            <h1 className="plugin-market-title text-text-primary">
              {t('workbench.plugins_marketplace_title', '插件市场')}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-text-secondary">
              {t(
                'workbench.plugins_marketplace_subtitle',
                '发现并接入开发工具、企业数据和专业方法。'
              )}
            </p>
            <span className="sr-only">
              {t('workbench.plugins_subtitle', '通过插件扩展 WeWork 能力')}
            </span>
          </div>
          <div
            data-testid="plugins-topbar-right-actions"
            className="flex w-full max-w-[420px] shrink-0 flex-col items-end gap-2 sm:w-auto"
          >
            <div className="flex items-center gap-2 md:gap-[9px]">
              <button
                type="button"
                data-testid="plugins-refresh-button"
                data-reconciling={isReconcilingPlugins}
                data-local-sync={localSyncAvailable}
                data-catalog-loading={pluginMarketplaceState.isLoading}
                data-marketplace-refreshing={isMarketplaceRefreshing}
                data-official-catalog-loading={openAiCatalog.loading}
                data-official-catalog-view={isOfficialCatalogView}
                data-reconciliation-revision={reconciliationRevision}
                aria-label={t('workbench.plugins_refresh_marketplace', '刷新插件市场')}
                disabled={isCatalogRefreshBusy}
                className="plugin-market-icon-button hidden disabled:opacity-50 md:inline-flex"
                onClick={refreshMarketplace}
              >
                <RefreshCw
                  className={['h-4 w-4', isCatalogRefreshBusy ? 'animate-spin' : ''].join(' ')}
                />
              </button>
              <PluginCreateMenu
                isOpen={isCreateMenuOpen}
                onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                onCreatePlugin={openPluginCreator}
                onImportPlugin={() => {
                  setIsCreateMenuOpen(false)
                  setShowPluginImportDialog(true)
                }}
                onAddMarket={() => {
                  setIsCreateMenuOpen(false)
                  setShowAddMarketDialog(true)
                }}
              />
              <button
                type="button"
                data-testid="plugins-manage-button"
                className="plugin-market-action-button"
                onClick={() => navigateTo('/plugins/manage')}
              >
                <Settings2 className="h-[17px] w-[17px]" aria-hidden="true" />
                {t('workbench.plugins_manage_plugins', '管理插件')}
              </button>
            </div>
            {isReconcilingPlugins && (
              <PluginReconciliationStatus
                stage={reconciliation.stage}
                startedAt={reconciliation.startedAt}
              />
            )}
          </div>
        </header>

        <MarketplaceCatalogView
          hasMarketplace={hasMarketplace}
          marketplaces={marketplaces}
          selectedMarketplaceKey={selectedMarketplaceKey}
          selectedDistributionTab={selectedDistributionTab}
          marketplaceSourceFilterKey={marketplaceSourceFilterKey}
          marketplaceDistributionLabels={marketplaceDistributionLabels}
          localMarketplaceTabs={localMarketplaceTabs}
          query={query}
          searchInputRef={marketplaceSearchInputRef}
          scrollRef={bindMarketplaceViewport}
          showInstalledStrip={showInstalledStrip}
          installedStrip={
            showInstalledStrip ? (
              <InstalledPluginStrip
                plugins={installedStripPlugins}
                hiddenPlugins={hiddenInstalledPlugins}
                marketplaceItems={pluginMarketplaceState.items}
                sidebarCollapsed={sidebarCollapsed}
                onOpen={openInstalledPluginDetail}
              />
            ) : null
          }
          pluginMarketplaceState={pluginMarketplaceState}
          marketplaceLoadingMessage={marketplaceLoadingMessage}
          isMarketplaceRefreshing={isMarketplaceRefreshing}
          isMarketplaceSearchUpdating={isMarketplaceSearchUpdating}
          isOpenAiOfficialViewLoading={isOpenAiOfficialViewLoading}
          openAiCatalogError={openAiCatalog.error}
          isOpenAiCatalogRefreshing={openAiCatalog.loading}
          normalizedQuery={normalizedQuery}
          visibleMarketplaceItems={visibleMarketplaceItems}
          marketplaceCategorySections={marketplaceCategorySections}
          visibleSearchResultLimit={visibleSearchResultLimit}
          isLoggedIn={Boolean(cloudToken && (localSyncAvailable || currentDeviceId))}
          isReconciling={reconciliationBlocksActions}
          installingMarketplacePluginIds={installingMarketplacePluginIds}
          isLocallyUninstalling={isMarketplacePluginLocallyUninstalling}
          allowPendingRetry={deviceAutoSyncSettled || !deviceCloudConnected}
          showPendingAsSyncing={localInventoryReady && deviceCloudConnected}
          rowLabels={marketplaceRowLabels}
          onSelectDistributionTab={handleSelectDistributionTab}
          onSelectLocalMarketplaceTab={handleSelectLocalMarketplaceTab}
          onQueryChange={setQuery}
          onRefresh={refreshMarketplace}
          onClearFilters={handleClearMarketplaceFilters}
          onRevealMore={handleRevealMore}
          onAction={handleMarketplaceRowAction}
        />
      </div>
      {pluginOverlayDialogs}
      {pluginOperationNoticeOverlay}
      {browsingCategorySection && (
        <CategoryBrowseDialog
          section={browsingCategorySection}
          isLoggedIn={Boolean(cloudToken && (localSyncAvailable || currentDeviceId))}
          isReconciling={reconciliationBlocksActions}
          installingMarketplacePluginIds={installingMarketplacePluginIds}
          isLocallyUninstalling={isMarketplacePluginLocallyUninstalling}
          allowPendingRetry={deviceAutoSyncSettled || !deviceCloudConnected}
          showPendingAsSyncing={localInventoryReady && deviceCloudConnected}
          rowLabels={marketplaceRowLabels}
          onClose={() => setBrowsingCategoryKey(null)}
          onAction={handleMarketplaceRowAction}
        />
      )}
      {showAddMarketDialog && (
        <AddMarketDialog
          isOpen={showAddMarketDialog}
          isSubmitting={isAddingMarket}
          formData={addMarketForm}
          onClose={() => setShowAddMarketDialog(false)}
          onChange={setAddMarketForm}
          onSubmit={addMarketplace}
        />
      )}
      {pluginShareDialog}
      {pluginPublishDialog}
    </main>
  )
}
