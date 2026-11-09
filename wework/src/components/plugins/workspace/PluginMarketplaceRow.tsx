import { memo, useMemo } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { MoreHorizontal, RefreshCw, UserRoundX } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalAppearance } from '@/features/appearance'
import { marketplaceItemOffersDeviceSyncRetry } from '@/features/plugins/pluginDeviceAutoSync'
import { resolvePluginLogo } from '../plugin-assets'
import { marketplacePluginLockLabel, resolveMarketplacePluginLock } from '../marketplacePluginLock'
import { shouldShowInstalledMarketplaceActions } from '../marketplaceCatalogMerge'
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
      <button
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
      </button>
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
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                data-testid={`plugin-marketplace-actions-${item.id}`}
                aria-label={`${t('workbench.plugins_more_actions', '更多操作')} ${
                  item.displayName || item.name
                }`}
                className="plugin-market-card-menu"
                onClick={event => {
                  event.stopPropagation()
                }}
              >
                <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                data-testid={`plugin-marketplace-actions-menu-${item.id}`}
                aria-label={`${t('workbench.plugins_more_actions', '更多操作')} ${item.displayName || item.name}`}
                align="end"
                sideOffset={4}
                collisionPadding={8}
                hideWhenDetached
                className="z-system-popover max-h-[var(--radix-popover-content-available-height)] w-44 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border/30 bg-popover p-1 shadow-lg outline-none"
                onClick={event => event.stopPropagation()}
              >
                <Popover.Close asChild>
                  <button
                    type="button"
                    data-testid={`plugin-marketplace-try-${item.id}`}
                    className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface"
                    onClick={() => onAction('try', item)}
                  >
                    {labels.try}
                  </button>
                </Popover.Close>
                {item.accessRole === 'recipient' && item.allowCopy ? (
                  <Popover.Close asChild>
                    <button
                      type="button"
                      data-testid={`plugin-marketplace-copy-${item.id}`}
                      className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface"
                      onClick={() => onAction('copy', item)}
                    >
                      {labels.copy}
                    </button>
                  </Popover.Close>
                ) : null}
                <Popover.Close asChild>
                  <button
                    type="button"
                    data-testid={`plugin-marketplace-manage-${item.id}`}
                    className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface"
                    onClick={() => onAction('manage', item)}
                  >
                    {labels.manage}
                  </button>
                </Popover.Close>
                <div className="my-1 border-t border-border/25" />
                <Popover.Close asChild>
                  <button
                    type="button"
                    data-testid={`plugin-marketplace-uninstall-${item.id}`}
                    className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-destructive transition-colors hover:bg-destructive/10"
                    onClick={() => onAction('uninstall', item)}
                  >
                    {labels.uninstall}
                  </button>
                </Popover.Close>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : (
          <button
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
          </button>
        )}
      </div>
    </article>
  )
}, arePluginMarketplaceRowPropsEqual)
