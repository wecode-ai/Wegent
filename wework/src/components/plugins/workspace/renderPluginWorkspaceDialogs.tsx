import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { GithubCliAuthDialog } from '../GithubCliAuthDialog'
import { isGithubCliTarget } from '@/api/local/githubCli'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { PluginImportDialog } from '../PluginImportDialog'
import { PluginOperationNotice } from '../PluginOperationNotice'
import { PluginPublishDialog } from '../PluginPublishDialog'
import { PluginPublicationProgressDrawer } from '../PluginPublicationProgressDrawer'
import { PluginShareDialog } from '../PluginShareDialog'
import { InstallPluginDialog } from '../plugin-dialogs/InstallPluginDialog'
import { DeletePersonalPluginDialog } from '../plugin-dialogs/DeletePersonalPluginDialog'
import { UninstallPluginDialog } from '../plugin-dialogs/UninstallPluginDialog'
import { resolvePluginLogo } from '../plugin-assets'
import { isOfficialMarketplacePlugin, marketplacePluginDistribution } from '../pluginDistribution'
import {
  localMarketplaceKey,
  marketplaceComponentCount,
  rememberMarketplaceKey,
} from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginsWorkspaceController } from './usePluginsWorkspaceController'

export function renderPluginWorkspaceDialogs({
  requestDialogs,
  pluginShareState,
  pluginShareSaving,
  pluginShareError,
  setPluginShareState,
  savePluginShare,
  searchPluginShareUsers,
  searchPluginShareGroups,
  pluginPublishTarget,
  isUploadingPlugin,
  pluginPublishError,
  pluginPublishAccess,
  pluginPublishPublication,
  setPluginPublishTarget,
  setPluginPublishAccess,
  openPublicationProgress,
  pluginPublishShareRecovery,
  t,
  recoverPublishToShare,
  setPluginPublishError,
  setPluginPublishShareRecovery,
  publishCreatedPlugin,
  publicationProgress,
  publicationProgressHistory,
  publicationProgressLoading,
  withdrawingPublicationId,
  publications,
  withdrawPublication,
  openPublicationRevision,
  openPublishedEnterprisePlugin,
  pluginOperationNotice,
  catalog,
  pendingInstall,
  appearanceMode,
  pendingPluginUpdate,
  reconciliationBlocksActions,
  setPendingPluginUpdate,
  installMarketplacePlugin,
  setPendingInstall,
  executeMarketplaceInstall,
  pendingPluginUninstall,
  setPendingPluginUninstall,
  confirmUninstallPlugin,
  pendingPersonalPluginDelete,
  isDeletingPersonalPlugin,
  setPendingPersonalPluginDelete,
  confirmDeletePersonalPlugin,
  pendingLocalConnectorAuth,
  operations,
  pendingCodexAuthorization,
  checkingCodexAuthorization,
  setPendingCodexAuthorization,
  verifyCodexAuthorization,
  showPluginImportDialog,
  localPluginApi,
  setShowPluginImportDialog,
  setMarketplaceSourceFilterKey,
  setQuery,
  syncPersonalPluginInBackground,
  refreshLocalMarketplace,
}: PluginsWorkspaceController) {
  const pluginShareDialog = pluginShareState ? (
    <PluginShareDialog
      pluginName={pluginShareState.plugin.displayName || pluginShareState.plugin.name}
      access={pluginShareState.access}
      saving={pluginShareSaving}
      error={pluginShareError}
      onClose={() => setPluginShareState(null)}
      onSave={request => void savePluginShare(request)}
      searchUsers={searchPluginShareUsers}
      searchGroups={searchPluginShareGroups}
    />
  ) : null
  const pluginPublishDialog = pluginPublishTarget ? (
    <PluginPublishDialog
      pluginName={pluginPublishTarget.name}
      pluginVersion={pluginPublishTarget.version || '0.1.0'}
      publishing={isUploadingPlugin}
      error={pluginPublishError}
      initialAccess={pluginPublishAccess}
      activePublication={
        pluginPublishPublication
          ? {
              id: pluginPublishPublication.id,
              version: pluginPublishPublication.requestedVersion,
              status: pluginPublishPublication.status,
              canCreateRevision: pluginPublishPublication.actionEligibility.canCreateRevision,
            }
          : null
      }
      onViewPublication={requestId => {
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        void openPublicationProgress(requestId)
      }}
      shareRecoveryLabel={
        pluginPublishShareRecovery
          ? t('workbench.plugins_version_exists_go_share', '去分享成员')
          : null
      }
      onShareRecovery={pluginPublishShareRecovery ? recoverPublishToShare : undefined}
      onClose={() => {
        if (isUploadingPlugin) return
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        setPluginPublishError(null)
        setPluginPublishShareRecovery(false)
      }}
      onPublish={request => void publishCreatedPlugin(pluginPublishTarget, request)}
      searchUsers={searchPluginShareUsers}
      searchGroups={searchPluginShareGroups}
    />
  ) : null
  const publicationProgressDrawer = publicationProgress ? (
    <PluginPublicationProgressDrawer
      publication={publicationProgress}
      requestHistory={publicationProgressHistory}
      loading={publicationProgressLoading}
      withdrawing={withdrawingPublicationId === publicationProgress.id}
      onClose={() => publications.closeProgress()}
      onRefresh={() =>
        void openPublicationProgress(publicationProgress.id, publicationProgress.revision.number)
      }
      onSelectRequest={requestId => void openPublicationProgress(requestId)}
      onSelectRevision={revisionNumber =>
        void openPublicationProgress(publicationProgress.id, revisionNumber)
      }
      onWithdraw={
        publicationProgress.actionEligibility.canWithdraw
          ? () => void withdrawPublication(publicationProgress)
          : undefined
      }
      onCreateRevision={
        publicationProgress.actionEligibility.canCreateRevision
          ? () => openPublicationRevision(publicationProgress)
          : undefined
      }
      onViewEnterprise={
        publicationProgress.actionEligibility.canViewEnterprisePlugin
          ? () => void openPublishedEnterprisePlugin(publicationProgress)
          : undefined
      }
    />
  ) : null
  const pluginOperationNoticeOverlay = pluginOperationNotice ? (
    <PluginOperationNotice
      notice={pluginOperationNotice}
      onDismiss={() => catalog.showNotice(null)}
    />
  ) : null
  const pendingInstallLogo = pendingInstall
    ? resolvePluginLogo({
        pluginKey: pendingInstall.item.name,
        logo: pendingInstall.item.interface?.logo,
        logoDark: pendingInstall.item.interface?.logoDark,
        composerIcon: pendingInstall.item.interface?.composerIcon,
        appearanceMode,
      })
    : null
  const pluginOverlayDialogs = (
    <>
      {requestDialogs}
      <ConfirmDialog
        open={pendingPluginUpdate !== null}
        title={t('workbench.plugins_update', '更新')}
        description={t(
          'workbench.plugins_update_confirm',
          '更新将同步到当前设备。若失败，本机将保留当前已安装版本。是否继续？'
        )}
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.plugins_update', '更新')}
        confirmTestId="plugin-update-confirm-button"
        pending={reconciliationBlocksActions}
        onClose={() => setPendingPluginUpdate(null)}
        onConfirm={() => {
          const item = pendingPluginUpdate
          setPendingPluginUpdate(null)
          if (item) void installMarketplacePlugin(item, undefined, true)
        }}
      />
      {pendingInstall && (
        <InstallPluginDialog
          plugin={{
            id: pendingInstall.item.id,
            name: pendingInstall.item.displayName || pendingInstall.item.name,
            publisher: pendingInstall.item.author || pendingInstall.item.sourceLabel,
            version: pendingInstall.item.version,
            logoUrl: pendingInstallLogo?.url,
            logoContrastPad: pendingInstallLogo?.contrastPad,
            useLogoInitial: pendingInstallLogo?.source === 'fallback',
            logoDistribution: marketplacePluginDistribution(pendingInstall.item),
            isOfficial: isOfficialMarketplacePlugin(pendingInstall.item),
            componentCount: marketplaceComponentCount(pendingInstall.item),
            requiredConnectionNames: pendingInstall.requiredConnectionNames,
          }}
          confirmDisabled={reconciliationBlocksActions}
          onCancel={() => setPendingInstall(null)}
          onConfirm={() => executeMarketplaceInstall()}
        />
      )}
      {pendingPluginUninstall && (
        <UninstallPluginDialog
          pluginName={pendingPluginUninstall.name}
          scope={pendingPluginUninstall.scope}
          onCancel={() => setPendingPluginUninstall(null)}
          onConfirm={confirmUninstallPlugin}
        />
      )}
      {pendingPersonalPluginDelete && (
        <DeletePersonalPluginDialog
          pluginName={pendingPersonalPluginDelete.displayName}
          installed={pendingPersonalPluginDelete.installedId !== null}
          published={pendingPersonalPluginDelete.cloudPluginId !== null}
          publicationActive={pendingPersonalPluginDelete.publication !== null}
          impact={pendingPersonalPluginDelete.impact}
          deleting={isDeletingPersonalPlugin}
          onCancel={() => {
            if (!isDeletingPersonalPlugin) setPendingPersonalPluginDelete(null)
          }}
          onConfirm={() => void confirmDeletePersonalPlugin()}
        />
      )}
      {pendingLocalConnectorAuth && isGithubCliTarget(pendingLocalConnectorAuth.target) ? (
        <GithubCliAuthDialog
          onSuccess={() => {
            const pending = pendingLocalConnectorAuth
            operations.dismissLocalAuth(pendingLocalConnectorAuth)
            pending.resolve()
          }}
          onCancel={() => {
            const pending = pendingLocalConnectorAuth
            operations.dismissLocalAuth(pendingLocalConnectorAuth)
            pending.reject(new Error(t('workbench.plugins_local_auth_cancelled')))
          }}
        />
      ) : pendingLocalConnectorAuth ? (
        <LocalConnectorAuthDialog
          open
          target={pendingLocalConnectorAuth.target}
          title={pendingLocalConnectorAuth.title}
          description={pendingLocalConnectorAuth.description}
          onSuccess={() => {
            const pending = pendingLocalConnectorAuth
            operations.dismissLocalAuth(pendingLocalConnectorAuth)
            pending.resolve()
          }}
          onCancel={() => {
            const pending = pendingLocalConnectorAuth
            operations.dismissLocalAuth(pendingLocalConnectorAuth)
            pending.reject(
              new Error(t('workbench.plugins_local_auth_cancelled', '已取消授权，安装已终止'))
            )
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(pendingCodexAuthorization)}
        title={t('workbench.plugins_connector_auth_title', {
          name: pendingCodexAuthorization?.app.name,
        })}
        description={
          pendingCodexAuthorization?.error ||
          t('workbench.plugins_connector_auth_browser', {
            name: pendingCodexAuthorization?.app.name,
          })
        }
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.plugins_connector_auth_verify')}
        confirmTestId="plugin-connector-auth-verify"
        cancelTestId="plugin-connector-auth-cancel"
        dialogTestId="plugin-connector-auth-dialog"
        pending={checkingCodexAuthorization}
        onClose={() => setPendingCodexAuthorization(null)}
        onConfirm={() => void verifyCodexAuthorization()}
      />
      {showPluginImportDialog ? (
        <PluginImportDialog
          pluginApi={localPluginApi}
          onCancel={() => setShowPluginImportDialog(false)}
          onImported={imported => {
            setShowPluginImportDialog(false)
            notifyLocalPluginSkillsChanged()
            catalog.showNotice({
              id: 'plugin-import-complete',
              kind: 'success',
              message: t(
                'workbench.plugins_import_success_auth_deferred',
                '插件已导入并安装。如需连接器授权，可稍后在插件详情中登录。'
              ),
              actionLabel: t('workbench.plugins_import_view_plugin', '查看插件'),
              onAction: () => {
                const personalKey = localMarketplaceKey(WEWORK_PERSONAL_MARKETPLACE_ID)
                rememberMarketplaceKey(personalKey)
                catalog.selectMarketplace(personalKey)
                setMarketplaceSourceFilterKey(personalKey)
                catalog.showNotice(null)
                setQuery(imported.pluginName)
              },
            })
            refreshLocalMarketplace()
            syncPersonalPluginInBackground?.(imported)
          }}
        />
      ) : null}
    </>
  )
  return {
    pluginShareDialog,
    pluginPublishDialog,
    publicationProgressDrawer,
    pluginOperationNoticeOverlay,
    pluginOverlayDialogs,
  }
}
