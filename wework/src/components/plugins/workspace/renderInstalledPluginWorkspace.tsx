import {
  matchingPublicationRequests,
  selectPrimaryPublication,
} from '../workspace/pluginPublicationState'
import { navigateTo } from '@/lib/navigation'
import { queuePluginPromptTrial } from '@/features/plugins/pluginTrial'
import { marketplaceItemHasPausedPluginAutoUpdate } from '@/features/plugins/pluginAutoUpdate'
import { PluginDetailView } from '../PluginDetailView'
import { isCloudManagedInstalledPlugin } from '../installedPluginMerge'
import { findMarketplaceItemForInstalled } from '../findMarketplaceItemForInstalled'
import { resolvePluginOwnerActions } from '../pluginOwnerActions'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from '../pluginOwnerLocalPackage'
import { pluginDetailReadyToTry } from '../pluginDetailReadyToTry'
import {
  currentDeviceInstallation,
  pluginDetailActionErrorMessage,
  tryPluginInChat,
} from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginsWorkspaceViewContext } from './pluginWorkspaceViewContext'
import {
  isLocalPersonalPlugin,
  syncPersonalPluginToCurrentAccount,
} from './personalPluginCloudInstall'

export function renderInstalledPluginWorkspace({
  selectedPlugin,
  syncPersonalPluginInBackground,
  catalog,
  operations,
  findOwnedMarketplacePlugin,
  pluginMarketplaceState,
  publicationRequests,
  createdPluginSlug,
  installedPlugins,
  currentDeviceId,
  isInstalledPluginUninstalling,
  installingMarketplacePluginIds,
  isReconcilingPlugins,
  pluginPublishPreparing,
  isUploadingPlugin,
  openCreatedPluginAccess,
  openPackablePublish,
  t,
  pluginDetailActionError,
  withdrawingPublicationId,
  openPublishedEnterprisePlugin,
  openPublicationProgress,
  openPublicationRevision,
  versionSubmission,
  closePluginDetail,
  setSelectedPluginId,
  requestDeletePersonalPlugin,
  setPluginDetailActionError,
  togglePluginComponent,
  updatingPluginPolicyIds,
  changePluginAutoUpdatePolicy,
  requestUninstallPlugin,
  managePluginConnector,
  localConnectorAuthBySlug,
  connectorActionSlug,
  pluginShareDialog,
  pluginPublishDialog,
  publicationProgressDrawer,
  pluginOperationNoticeOverlay,
  pluginOverlayDialogs,
}: PluginsWorkspaceViewContext) {
  if (selectedPlugin) {
    const ownedMarketplace = findOwnedMarketplacePlugin(selectedPlugin)
    const associatedListing =
      ownedMarketplace ??
      findMarketplaceItemForInstalled(selectedPlugin, pluginMarketplaceState.items) ??
      null
    const selectedPluginPublications = matchingPublicationRequests(
      publicationRequests,
      ownedMarketplace?.visibility === 'personal' ? Number(ownedMarketplace.id) : null,
      createdPluginSlug(selectedPlugin)
    )
    const selectedPublication = selectPrimaryPublication(selectedPluginPublications)
    const packableCreated =
      associatedListing && !marketplaceItemOwnsLocalCreatedPackage(associatedListing)
        ? null
        : (findPackableCreatedPlugin(installedPlugins, [
            selectedPlugin.raw.spec.source.pluginKey,
            createdPluginSlug(selectedPlugin),
            selectedPlugin.name,
            ownedMarketplace?.name,
            ownedMarketplace?.displayName,
          ]) ?? (isPackableCreatedPlugin(selectedPlugin) ? selectedPlugin : null))
    const ownerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing: associatedListing,
    })
    const continueEditingKey = resolveContinueEditingPluginKey({
      packableCreated,
      currentPlugin: selectedPlugin,
      ownedListingName: ownedMarketplace?.name,
      listing: associatedListing,
    })
    const submissionStatus =
      typeof selectedPlugin.raw.spec.sourcePayload?.submissionStatus === 'string'
        ? (selectedPlugin.raw.spec.sourcePayload.submissionStatus as
            | 'uploading'
            | 'scanning'
            | 'pending'
            | 'approved'
            | 'rejected'
            | 'cancelled')
        : null
    const submissionReviewNote =
      typeof selectedPlugin.raw.spec.sourcePayload?.submissionReviewNote === 'string'
        ? selectedPlugin.raw.spec.sourcePayload.submissionReviewNote
        : null
    const selectedDeviceInstallation = currentDeviceInstallation(
      selectedPlugin.raw,
      currentDeviceId
    )
    const selectedUninstalling = isInstalledPluginUninstalling(selectedPlugin)
    const selectedAutoUpdatePaused = marketplaceItemHasPausedPluginAutoUpdate({
      updateAvailable: selectedPlugin.updateAvailable,
      currentDeviceInstallation: selectedDeviceInstallation,
    })
    const headerBusy = pluginPublishPreparing || isUploadingPlugin || submissionStatus === 'pending'
    const openOwnerShare = () => void openCreatedPluginAccess(selectedPlugin)
    const openOwnerPublish = () =>
      openPackablePublish(
        [
          selectedPlugin.raw.spec.source.pluginKey,
          createdPluginSlug(selectedPlugin),
          selectedPlugin.name,
          ownedMarketplace?.name,
          ownedMarketplace?.displayName,
        ],
        selectedPlugin
      )
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          actionError={pluginDetailActionErrorMessage(pluginDetailActionError, selectedPlugin.id)}
          usableOnThisDevice={pluginDetailReadyToTry(selectedPlugin, ownedMarketplace)}
          primaryActionLabel={
            selectedUninstalling
              ? t('workbench.plugins_uninstalling', '正在卸载')
              : t('workbench.plugins_try_now', '立即对话')
          }
          primaryActionDisabled={selectedUninstalling}
          shareActionLabel={t('workbench.plugins_share', '分享')}
          shareActionDisabled={headerBusy}
          onShareAction={ownerActions.showShareAction ? openOwnerPublish : undefined}
          publication={selectedPublication}
          publicationWithdrawing={withdrawingPublicationId === selectedPublication?.id}
          onViewPublication={
            selectedPublication
              ? selectedPublication.actionEligibility.canViewEnterprisePlugin
                ? () => void openPublishedEnterprisePlugin(selectedPublication)
                : () => void openPublicationProgress(selectedPublication.id)
              : undefined
          }
          onWithdrawPublication={
            selectedPublication?.actionEligibility?.canWithdraw
              ? () => void openPublicationProgress(selectedPublication.id)
              : undefined
          }
          onCreatePublicationRevision={
            selectedPublication?.actionEligibility?.canCreateRevision
              ? () => openPublicationRevision(selectedPublication)
              : undefined
          }
          publicationHistoryCount={selectedPluginPublications.length}
          onViewPublicationHistory={
            selectedPublication && selectedPluginPublications.length > 1
              ? () => void openPublicationProgress(selectedPublication.id)
              : undefined
          }
          accessRole={associatedListing?.accessRole}
          shareRecipient={associatedListing?.accessRole === 'recipient'}
          versionSubmission={versionSubmission.actionFor(packableCreated, ownedMarketplace ?? null)}
          pluginVisibility={associatedListing?.visibility ?? null}
          shareGrantUserCount={ownedMarketplace?.grantUserCount ?? 0}
          shareGrantNamespaceCount={ownedMarketplace?.grantNamespaceCount ?? 0}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={ownerActions.canManageAccess ? openOwnerShare : undefined}
          submissionStatus={submissionStatus}
          submissionReviewNote={submissionReviewNote}
          onBack={() => closePluginDetail(() => setSelectedPluginId(null))}
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          onSyncToAccount={
            packableCreated &&
            isLocalPersonalPlugin(packableCreated.raw) &&
            associatedListing?.accessRole === 'owner' &&
            associatedListing.visibility === 'personal' &&
            syncPersonalPluginInBackground
              ? () =>
                  void syncPersonalPluginToCurrentAccount({
                    plugin: packableCreated,
                    listing: associatedListing,
                    sync: syncPersonalPluginInBackground,
                    catalog,
                    operations,
                    t,
                  })
              : undefined
          }
          syncToAccountDisabled={
            headerBusy ||
            selectedUninstalling ||
            isReconcilingPlugins ||
            installingMarketplacePluginIds.has(associatedListing?.id ?? '')
          }
          deleteActionLabel={t('workbench.plugins_delete_plugin', '删除插件')}
          deleteActionDisabled={headerBusy}
          onDeleteAction={
            packableCreated
              ? () =>
                  void requestDeletePersonalPlugin({
                    pluginName: packableCreated.raw.spec.source.pluginKey,
                    displayName: selectedPlugin.name,
                    marketplacePath:
                      typeof packableCreated.raw.spec.sourcePayload?.marketplacePath === 'string'
                        ? packableCreated.raw.spec.sourcePayload.marketplacePath
                        : null,
                    installedId: packableCreated.id,
                  })
              : undefined
          }
          onToggle={() => {
            if (isInstalledPluginUninstalling(selectedPlugin)) return
            if (!tryPluginInChat(selectedPlugin.raw)) {
              setPluginDetailActionError({
                pluginId: selectedPlugin.id,
                message: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
              })
            }
          }}
          onPromptSelect={prompt => {
            if (isInstalledPluginUninstalling(selectedPlugin)) return
            if (queuePluginPromptTrial(selectedPlugin.raw, prompt, { openInNewChat: true })) {
              navigateTo('/')
            }
          }}
          onComponentToggle={(componentKey, enabled) =>
            togglePluginComponent(selectedPlugin.id, componentKey, enabled)
          }
          autoUpdateEnabled={selectedPlugin.raw.spec.updatePolicy === 'auto'}
          autoUpdateSaving={updatingPluginPolicyIds.has(selectedPlugin.id)}
          autoUpdatePaused={
            selectedPlugin.raw.spec.updatePolicy === 'auto' && selectedAutoUpdatePaused
          }
          autoUpdateFailureCount={selectedDeviceInstallation?.attemptCount ?? 0}
          onAutoUpdateChange={
            isCloudManagedInstalledPlugin(selectedPlugin.raw)
              ? enabled => changePluginAutoUpdatePolicy(selectedPlugin, enabled)
              : undefined
          }
          onUninstall={() => requestUninstallPlugin(selectedPlugin.id, selectedPlugin.name)}
          onManageConnector={slug => void managePluginConnector(slug, selectedPlugin)}
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
