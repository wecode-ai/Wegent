import {
  matchingPublicationRequests,
  selectPrimaryPublication,
} from '../workspace/pluginPublicationState'
import { navigateTo } from '@/lib/navigation'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import {
  isPersonalMarketplaceId,
  WEWORK_PERSONAL_MARKETPLACE_ID,
} from '@/features/plugins/builtinPlugins'
import { marketplaceItemOffersDeviceSyncRetry } from '@/features/plugins/pluginDeviceAutoSync'
import {
  marketplaceItemCanRetryPluginUpdate,
  marketplaceItemHasPausedPluginAutoUpdate,
} from '@/features/plugins/pluginAutoUpdate'
import { PluginDetailView } from '../PluginDetailView'
import { isCloudManagedInstalledPlugin } from '../installedPluginMerge'
import { resolvePluginOwnerActions } from '../pluginOwnerActions'
import {
  createdPluginSlugFromKey,
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from '../pluginOwnerLocalPackage'
import { marketplaceItemMarketplaceId, marketplacePluginDistribution } from '../pluginDistribution'
import { pluginDetailPrimaryActionPending, pluginDetailReadyToTry } from '../pluginDetailReadyToTry'
import {
  findInstalledPluginForMarketplaceItem,
  pluginDetailActionErrorMessage,
  requiredConnectionNames,
  toMarketplaceInstalledPluginItem,
  withMarketplaceDetailComponents,
  withMarketplaceListingInterface,
  withMarketplacePluginDetail,
} from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginsWorkspaceViewContext } from './pluginWorkspaceViewContext'

export function renderMarketplacePluginWorkspace({
  selectedMarketplacePlugin,
  installedPlugins,
  selectedMarketplacePluginDetail,
  selectedRequiredConnectionNames,
  deviceAutoSyncSettled,
  installingMarketplacePluginIds,
  isMarketplacePluginUninstalling,
  reconciliationBlocksActions,
  pluginMarketplaceState,
  publicationRequests,
  openPluginShare,
  openPackablePublish,
  marketplaceDetailLoading,
  t,
  versionSubmission,
  pluginPublishPreparing,
  isUploadingPlugin,
  pluginSharePreparing,
  withdrawingPublicationId,
  openPublishedEnterprisePlugin,
  openPublicationProgress,
  openPublicationRevision,
  requestDeletePersonalPlugin,
  marketplaceDetailLoadError,
  pluginDetailActionError,
  setMarketplaceDetailRevision,
  copyMarketplacePlugin,
  closePluginDetail,
  setSelectedMarketplacePluginId,
  installMarketplacePlugin,
  beginMarketplacePluginTrial,
  togglePluginComponent,
  updatingPluginPolicyIds,
  changePluginAutoUpdatePolicy,
  requestUninstallPlugin,
  marketplaceUninstallId,
  managePluginConnector,
  localConnectorAuthBySlug,
  connectorActionSlug,
  pluginShareDialog,
  pluginPublishDialog,
  publicationProgressDrawer,
  pluginOperationNoticeOverlay,
  pluginOverlayDialogs,
}: PluginsWorkspaceViewContext) {
  if (selectedMarketplacePlugin) {
    const installedDetail = findInstalledPluginForMarketplaceItem(
      selectedMarketplacePlugin,
      installedPlugins
    )
    const baseDetailPlugin = installedDetail
      ? withMarketplaceListingInterface(installedDetail, selectedMarketplacePlugin)
      : toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)
    // Detail reads enrich presentation; the inventory owns installation identity.
    const detailPlugin = selectedMarketplacePluginDetail
      ? withMarketplacePluginDetail(baseDetailPlugin, selectedMarketplacePluginDetail.raw)
      : baseDetailPlugin
    const detailedMarketplacePlugin = withMarketplaceDetailComponents(
      selectedMarketplacePlugin,
      detailPlugin
    )
    const declaredConnectionNames = requiredConnectionNames(detailedMarketplacePlugin)
    const detailRequiredConnectionNames = selectedRequiredConnectionNames ?? declaredConnectionNames
    const detailRequiresConnection = detailRequiredConnectionNames.length > 0
    const deviceState = selectedMarketplacePlugin.currentDeviceInstallation?.state
    const isInstalled = pluginDetailReadyToTry(baseDetailPlugin, selectedMarketplacePlugin)
    const isFailed = marketplaceItemOffersDeviceSyncRetry(selectedMarketplacePlugin, {
      autoSyncSettled: deviceAutoSyncSettled,
    })
    const isDeviceSyncing =
      !isFailed &&
      !isInstalled &&
      (deviceState === 'pending' || deviceState === 'downloading' || deviceState === 'installing')
    const isInstalling = installingMarketplacePluginIds.has(selectedMarketplacePlugin.id)
    const isUninstalling = isMarketplacePluginUninstalling(selectedMarketplacePlugin)
    const isActionPending = isInstalling || isUninstalling || isDeviceSyncing
    const canUpdate =
      marketplaceItemCanRetryPluginUpdate(selectedMarketplacePlugin) &&
      selectedMarketplacePlugin.installed &&
      selectedMarketplacePlugin.installedPluginId
    const primaryActionPending = pluginDetailPrimaryActionPending({
      operationPending: isActionPending,
      reconciling: reconciliationBlocksActions,
      readyToTry: isInstalled,
      updateAvailable: Boolean(canUpdate),
    })
    const autoUpdatePaused = marketplaceItemHasPausedPluginAutoUpdate(selectedMarketplacePlugin)
    const showDetailActionMenu =
      isInstalled ||
      (selectedMarketplacePlugin.installedPluginId !== null &&
        selectedMarketplacePlugin.installedPluginId !== undefined)
    const marketplacePrimaryIcon: 'try' | 'install' | 'none' = primaryActionPending
      ? 'none'
      : isInstalled
        ? 'try'
        : 'install'
    const detailMarketplaceId = marketplaceItemMarketplaceId(selectedMarketplacePlugin) || ''
    const ownedListing =
      selectedMarketplacePlugin.accessRole === 'owner' ? selectedMarketplacePlugin : null
    const packableCreated = marketplaceItemOwnsLocalCreatedPackage(selectedMarketplacePlugin)
      ? (findPackableCreatedPlugin(installedPlugins, [
          selectedMarketplacePlugin.name,
          createdPluginSlugFromKey(selectedMarketplacePlugin.name),
          selectedMarketplacePlugin.displayName,
          installedDetail?.raw.spec.source.pluginKey,
          installedDetail?.name,
        ]) ??
        (installedDetail && isPackableCreatedPlugin(installedDetail) ? installedDetail : null))
      : null
    const isOwnedPersonalListing =
      selectedMarketplacePlugin.accessRole === 'owner' &&
      selectedMarketplacePlugin.visibility === 'personal'
    const originPersonalListing = selectedMarketplacePlugin.originPersonalPluginId
      ? (pluginMarketplaceState.items.find(
          item =>
            String(item.id) === String(selectedMarketplacePlugin.originPersonalPluginId) &&
            item.visibility === 'personal' &&
            item.accessRole === 'owner'
        ) ?? null)
      : null
    const marketplacePluginPublications = isOwnedPersonalListing
      ? matchingPublicationRequests(
          publicationRequests,
          Number(selectedMarketplacePlugin.id),
          selectedMarketplacePlugin.name
        )
      : []
    const marketplacePublication = selectPrimaryPublication(marketplacePluginPublications)
    const hasDeletablePersonalSource =
      selectedMarketplacePlugin.accessRole !== 'recipient' &&
      (Boolean(packableCreated) ||
        Boolean(selectedMarketplacePlugin.localPersonalSource) ||
        (isPersonalMarketplaceId(detailMarketplaceId) &&
          selectedMarketplacePlugin.latestReleaseId == null))
    const marketplaceOwnerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing,
    })
    const continueEditingKey = resolveContinueEditingPluginKey({
      packableCreated,
      currentPlugin: installedDetail,
      ownedListingName: ownedListing?.name,
      listing: selectedMarketplacePlugin,
    })
    const openMarketplaceOwnerShare = () => void openPluginShare(selectedMarketplacePlugin)
    const openMarketplaceOwnerPublish = () =>
      openPackablePublish(
        [
          selectedMarketplacePlugin.name,
          createdPluginSlugFromKey(selectedMarketplacePlugin.name),
          selectedMarketplacePlugin.displayName,
          installedDetail?.raw.spec.source.pluginKey,
          installedDetail?.name,
        ],
        installedDetail
      )

    return (
      <>
        <PluginDetailView
          plugin={detailPlugin}
          detailLoading={marketplaceDetailLoading}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          usableOnThisDevice={isInstalled}
          accessRole={selectedMarketplacePlugin.accessRole}
          versionSubmission={versionSubmission.actionFor(packableCreated, ownedListing)}
          pluginVisibility={selectedMarketplacePlugin.visibility}
          shareGrantUserCount={selectedMarketplacePlugin.grantUserCount ?? 0}
          shareGrantNamespaceCount={selectedMarketplacePlugin.grantNamespaceCount ?? 0}
          shareRecipient={selectedMarketplacePlugin.accessRole === 'recipient'}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={
            marketplaceOwnerActions.canManageAccess ? openMarketplaceOwnerShare : undefined
          }
          shareActionLabel={t('workbench.plugins_share', '分享')}
          shareActionDisabled={pluginPublishPreparing || isUploadingPlugin || pluginSharePreparing}
          onShareAction={
            marketplaceOwnerActions.showShareAction
              ? packableCreated
                ? openMarketplaceOwnerPublish
                : openMarketplaceOwnerShare
              : undefined
          }
          publication={marketplacePublication}
          publicationWithdrawing={withdrawingPublicationId === marketplacePublication?.id}
          onViewPublication={
            marketplacePublication
              ? marketplacePublication.actionEligibility.canViewEnterprisePlugin
                ? () => void openPublishedEnterprisePlugin(marketplacePublication)
                : () => void openPublicationProgress(marketplacePublication.id)
              : undefined
          }
          onWithdrawPublication={
            marketplacePublication?.actionEligibility?.canWithdraw
              ? () => void openPublicationProgress(marketplacePublication.id)
              : undefined
          }
          onCreatePublicationRevision={
            marketplacePublication?.actionEligibility?.canCreateRevision
              ? () => openPublicationRevision(marketplacePublication)
              : undefined
          }
          publicationHistoryCount={marketplacePluginPublications.length}
          onViewPublicationHistory={
            marketplacePublication && marketplacePluginPublications.length > 1
              ? () => void openPublicationProgress(marketplacePublication.id)
              : undefined
          }
          originPersonalActionLabel={t(
            'workbench.plugin_detail_view_origin_personal',
            '查看个人创建版本'
          )}
          onOpenOriginPersonalPlugin={
            originPersonalListing
              ? () =>
                  navigateTo(
                    buildPluginDetailRoute({
                      pluginName: originPersonalListing.name,
                      marketplaceName: WEWORK_PERSONAL_MARKETPLACE_ID,
                    })
                  )
              : undefined
          }
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          deleteActionLabel={t('workbench.plugins_delete_plugin', '删除插件')}
          deleteActionDisabled={pluginPublishPreparing || isActionPending}
          onDeleteAction={
            isOwnedPersonalListing || hasDeletablePersonalSource
              ? () =>
                  void requestDeletePersonalPlugin({
                    pluginName:
                      selectedMarketplacePlugin.localPersonalSource?.pluginName ||
                      selectedMarketplacePlugin.name,
                    displayName:
                      selectedMarketplacePlugin.displayName || selectedMarketplacePlugin.name,
                    marketplacePath:
                      typeof packableCreated?.raw.spec.sourcePayload?.marketplacePath === 'string'
                        ? packableCreated.raw.spec.sourcePayload.marketplacePath
                        : selectedMarketplacePlugin.localPersonalSource?.marketplacePath
                          ? selectedMarketplacePlugin.localPersonalSource.marketplacePath
                          : typeof selectedMarketplacePlugin.manifest.marketplacePath === 'string'
                            ? selectedMarketplacePlugin.manifest.marketplacePath
                            : null,
                    installedId: packableCreated?.id ?? null,
                    cloudPluginId: isOwnedPersonalListing ? selectedMarketplacePlugin.id : null,
                    deleteLocalSource: hasDeletablePersonalSource,
                  })
              : undefined
          }
          isExternalSource={
            selectedMarketplacePlugin.sourceProvider === 'codex' ||
            marketplacePluginDistribution(selectedMarketplacePlugin) === 'public'
          }
          actionError={
            marketplaceDetailLoadError ||
            (deviceState === 'failed' &&
              selectedMarketplacePlugin.currentDeviceInstallation?.errorMessage) ||
            pluginDetailActionErrorMessage(pluginDetailActionError, selectedMarketplacePlugin.id)
          }
          onRetryAction={
            marketplaceDetailLoadError
              ? () => setMarketplaceDetailRevision(revision => revision + 1)
              : undefined
          }
          primaryActionLabel={
            primaryActionPending
              ? isUninstalling
                ? t('workbench.plugins_uninstalling', '正在卸载')
                : isInstalling
                  ? t('workbench.plugins_installing', '正在安装')
                  : t('workbench.plugins_syncing_installation', '同步中...')
              : canUpdate
                ? t('workbench.plugins_update', '更新')
                : isInstalled
                  ? t('workbench.plugins_try_now', '立即对话')
                  : isFailed
                    ? t('workbench.plugins_retry_install', '重试安装')
                    : detailRequiresConnection
                      ? t('workbench.plugins_install_and_connect_named', '安装并连接 {{name}}', {
                          name:
                            detailRequiredConnectionNames[0] ||
                            selectedMarketplacePlugin.displayName ||
                            selectedMarketplacePlugin.name,
                        })
                      : t('workbench.plugins_install_plugin', '安装插件')
          }
          primaryActionIcon={marketplacePrimaryIcon}
          primaryActionDisabled={primaryActionPending}
          tertiaryActionLabel={
            selectedMarketplacePlugin.accessRole === 'recipient' &&
            selectedMarketplacePlugin.allowCopy
              ? t('workbench.plugins_copy_to_personal', '复制到我的插件')
              : undefined
          }
          tertiaryActionDisabled={pluginSharePreparing}
          onTertiaryAction={
            selectedMarketplacePlugin.accessRole === 'recipient' &&
            selectedMarketplacePlugin.allowCopy
              ? () => void copyMarketplacePlugin(selectedMarketplacePlugin)
              : undefined
          }
          showUninstall={showDetailActionMenu}
          onBack={() => closePluginDetail(() => setSelectedMarketplacePluginId(null))}
          onToggle={() => {
            if (primaryActionPending || isMarketplacePluginUninstalling(selectedMarketplacePlugin))
              return
            if (canUpdate) {
              installMarketplacePlugin(selectedMarketplacePlugin)
              return
            }
            if (isInstalled) {
              beginMarketplacePluginTrial(selectedMarketplacePlugin, detailPlugin)
              return
            }
            installMarketplacePlugin(detailedMarketplacePlugin)
          }}
          onComponentToggle={(componentKey, enabled) => {
            if (installedDetail) {
              togglePluginComponent(installedDetail.id, componentKey, enabled)
            }
          }}
          autoUpdateEnabled={installedDetail?.raw.spec.updatePolicy === 'auto'}
          autoUpdateSaving={
            installedDetail ? updatingPluginPolicyIds.has(installedDetail.id) : false
          }
          autoUpdatePaused={
            Boolean(installedDetail?.raw.spec.updatePolicy === 'auto') && autoUpdatePaused
          }
          autoUpdateFailureCount={
            selectedMarketplacePlugin.currentDeviceInstallation?.attemptCount ?? 0
          }
          onAutoUpdateChange={
            installedDetail && isCloudManagedInstalledPlugin(installedDetail.raw)
              ? enabled => changePluginAutoUpdatePolicy(installedDetail, enabled)
              : undefined
          }
          onUninstall={() => {
            requestUninstallPlugin(
              marketplaceUninstallId(selectedMarketplacePlugin),
              selectedMarketplacePlugin.displayName || selectedMarketplacePlugin.name
            )
          }}
          onPromptSelect={prompt => {
            if (primaryActionPending || isMarketplacePluginUninstalling(selectedMarketplacePlugin))
              return
            if (isInstalled) {
              beginMarketplacePluginTrial(selectedMarketplacePlugin, detailPlugin, prompt)
              return
            }
            installMarketplacePlugin(detailedMarketplacePlugin, prompt)
          }}
          onManageConnector={slug => void managePluginConnector(slug, detailPlugin)}
          connectorAuthBySlug={localConnectorAuthBySlug}
          connectorAuthBusySlug={connectorActionSlug}
        />
        {pluginShareDialog}
        {versionSubmission.drawer}
        {pluginPublishDialog}
        {publicationProgressDrawer}
        {pluginOperationNoticeOverlay}
        {pluginOverlayDialogs}
      </>
    )
  }
}
