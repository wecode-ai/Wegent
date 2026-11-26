import { ActionMenu } from '@/components/common/ActionMenu'
import { useOptionalAppearance } from '@/features/appearance'
import { marketplaceItemOffersDeviceSyncRetry } from '@/features/plugins/pluginDeviceAutoSync'
import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { RefreshCw, UserRoundX } from 'lucide-react'
import { memo, useMemo } from 'react'
import { shouldShowInstalledMarketplaceActions } from '../marketplaceCatalogMerge'
import { marketplacePluginLockLabel, resolveMarketplacePluginLock } from '../marketplacePluginLock'
import { resolvePluginLogo } from '../plugin-assets'
import { marketplacePluginDistribution } from '../pluginDistribution'
import { PluginSourceAvatar } from '../PluginSourceAvatar'
import { marketplaceRowMetaItems } from './marketplaceWorkspaceHelpers'
import {
  arePluginMarketplaceRowPropsEqual,
  type PluginMarketplaceRowProps,
} from './pluginMarketplaceRowEquality'

export type {
  PluginMarketplaceRowAction,
  PluginMarketplaceRowLabels,
  PluginMarketplaceRowProps,
} from './pluginMarketplaceRowEquality'

export const PluginMarketplaceRow = memo(function PluginMarketplaceRow({
  item,
  isLoggedIn,
  isReconciling,
  isInstalling,
  isUninstalling,
  allowPendingRetry,
  showPendingAsSyncing = true,
  labels,
  testIdPrefix = '',
  onAction,
}: PluginMarketplaceRowProps) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const logo = useMemo(
    () =>
      resolvePluginLogo({
        pluginKey: item.name,
        logo: item.interface?.logo,
        logoDark: item.interface?.logoDark,
        composerIcon: item.interface?.composerIcon,
        appearanceMode,
      }),
    [
      appearanceMode,
      item.interface?.composerIcon,
      item.interface?.logo,
      item.interface?.logoDark,
      item.name,
    ]
  )
  const installLock = resolveMarketplacePluginLock(item)
  const installLockLabel = installLock ? marketplacePluginLockLabel(installLock, t) : ''
  const deviceState = item.currentDeviceInstallation?.state
  const showFailedState = marketplaceItemOffersDeviceSyncRetry(item, {
    autoSyncSettled: allowPendingRetry,
  })
  const showSyncingState =
    !showFailedState &&
    !item.installedLocally &&
    (deviceState === 'downloading' ||
      deviceState === 'installing' ||
      deviceState === 'uninstalling' ||
      (deviceState === 'pending' && showPendingAsSyncing))
  const showInstalledState =
    shouldShowInstalledMarketplaceActions(item, isLoggedIn) && !showFailedState && !showSyncingState
  const uninstallPending = isUninstalling || deviceState === 'uninstalling'
  const actionPending = isInstalling || uninstallPending || showSyncingState
  const pendingLabel = isUninstalling
    ? labels.uninstalling
    : isInstalling
      ? labels.installing
      : uninstallPending
        ? labels.uninstalling
        : labels.syncing
  const actionLabel = showFailedState
    ? labels.retry
    : showSyncingState
      ? labels.syncing
      : labels.install

  return (
    <article
      data-testid={`${testIdPrefix}plugin-marketplace-row-${item.id}`}
      className={['plugin-market-card', installLock ? 'is-locked' : ''].filter(Boolean).join(' ')}
      onClick={() => onAction('open', item)}
    >
      <ControlButton
        variant="unstyled"
        type="button"
        className="plugin-market-card-main"
        aria-label={`${t('workbench.plugins_view_plugin', '查看')} ${item.displayName || item.name}`}
        onClick={event => {
          event.stopPropagation()
          onAction('open', item)
        }}
      >
        <PluginSourceAvatar
          className={[
            'plugin-market-card-logo',
            logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
          ].join(' ')}
          contrastPad={logo.contrastPad}
          distribution={marketplacePluginDistribution(item)}
          logoUrl={logo.url}
          loading="lazy"
          name={item.displayName || item.name}
          useInitial={logo.source === 'fallback'}
        />
        <div className="plugin-market-card-copy">
          <strong>{item.displayName || item.name}</strong>
          <p>{item.interface?.shortDescription || item.description}</p>
          <div className="plugin-market-card-meta">
            {marketplaceRowMetaItems(item, t).map(label => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </ControlButton>
      <div className="plugin-market-card-action">
        {installLock ? (
          <div
            className="plugin-market-card-locked"
            role="status"
            data-testid={`${testIdPrefix}plugin-marketplace-locked-${item.id}`}
            data-lock-kind={installLock.kind}
            title={installLockLabel}
            aria-label={`${installLockLabel} ${item.displayName || item.name}`}
            onClick={event => event.stopPropagation()}
          >
            <span className="plugin-market-card-locked-label">{installLockLabel}</span>
            <UserRoundX className="plugin-market-card-locked-icon" aria-hidden="true" />
          </div>
        ) : actionPending ? (
          <span
            className="plugin-market-card-install-status"
            role="status"
            data-testid={`${testIdPrefix}plugin-marketplace-install-${item.id}`}
            aria-label={`${pendingLabel} ${item.displayName || item.name}`}
          >
            <RefreshCw className="animate-spin" aria-hidden="true" />
            <span>{pendingLabel}</span>
          </span>
        ) : showInstalledState ? (
          <div onClick={event => event.stopPropagation()}>
            <ActionMenu
              testId={`plugin-marketplace-actions-${item.id}`}
              menuTestId={`plugin-marketplace-actions-menu-${item.id}`}
              ariaLabel={`${t('workbench.plugins_more_actions', '更多操作')} ${item.displayName || item.name}`}
              density="dense"
              placement="bottom-end"
              triggerClassName="electron-titlebar-interactive-region plugin-market-card-menu"
              itemClassName="electron-titlebar-interactive-region"
              items={[
                {
                  testId: `plugin-marketplace-try-${item.id}`,
                  label: labels.try,
                  onSelect: () => onAction('try', item),
                },
                ...(item.accessRole === 'recipient' && item.allowCopy
                  ? [
                      {
                        testId: `plugin-marketplace-copy-${item.id}`,
                        label: labels.copy,
                        onSelect: () => onAction('copy', item),
                      },
                    ]
                  : []),
                {
                  testId: `plugin-marketplace-manage-${item.id}`,
                  label: labels.manage,
                  onSelect: () => onAction('manage', item),
                },
                { id: 'uninstall-separator', label: '', separator: true },
                {
                  testId: `plugin-marketplace-uninstall-${item.id}`,
                  label: labels.uninstall,
                  danger: true,
                  onSelect: () => onAction('uninstall', item),
                },
              ]}
            />
          </div>
        ) : (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`${testIdPrefix}plugin-marketplace-install-${item.id}`}
            aria-label={`${actionLabel} ${item.displayName || item.name}`}
            title={actionLabel}
            disabled={isReconciling}
            className={[
              'plugin-market-card-install disabled:cursor-not-allowed disabled:opacity-50',
              showFailedState ? 'is-failed' : '',
            ].join(' ')}
            onClick={event => {
              event.stopPropagation()
              onAction('install', item)
            }}
          >
            {showFailedState ? (
              <>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>{labels.retry}</span>
              </>
            ) : (
              <span>{labels.install}</span>
            )}
          </ControlButton>
        )}
      </div>
    </article>
  )
}, arePluginMarketplaceRowPropsEqual)
