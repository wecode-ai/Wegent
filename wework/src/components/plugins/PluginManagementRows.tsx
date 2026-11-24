import { ActionMenu } from '@/components/common/ActionMenu'
import { useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { Switch } from '@wegent/collaboration/controls/Switch'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Copy, Ellipsis, Loader2, MessageCirclePlus, Trash2, Upload, UserCog } from 'lucide-react'
import { resolvePreferredPluginLogo } from './plugin-assets'
import type { PluginDistribution } from './pluginDistribution'
import { buildInstalledPluginSubtitle } from './pluginManagementSubtitle'
import { PluginSourceAvatar } from './PluginSourceAvatar'

export interface InstalledPluginItem {
  id: string | number
  name: string
  description: string
  enabled: boolean
  version?: string | null
  origin: 'created' | 'market'
  sourceLabel: string
  distribution: PluginDistribution
  updateAvailable: boolean
  componentCounts: Record<string, number>
  raw: InstalledPlugin
}

const distributionPillClass: Record<PluginDistribution, string> = {
  official: 'plugin-management-pill-official',
  workspace: 'plugin-management-pill-workspace',
  personal: 'plugin-management-pill-personal',
  public: 'plugin-management-pill-public',
  external: 'plugin-management-pill-external',
}

export function InstalledPluginRow({
  plugin,
  marketplaceItem,
  onOpen,
  onTry,
  onPublish,
  publishLabel,
  onShare,
  shareLabel,
  onCopy,
  onToggle,
  onUninstall,
  isUninstalling = false,
}: {
  plugin: InstalledPluginItem
  marketplaceItem?: PluginMarketplaceItem
  onOpen?: () => void
  onTry?: () => void
  onPublish?: () => void
  publishLabel?: string
  onShare?: () => void
  shareLabel?: string
  onCopy?: () => void
  onToggle: () => void
  onUninstall: () => void
  isUninstalling?: boolean
}) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const shareRecipient = marketplaceItem?.accessRole === 'recipient'
  const toggleLabel = plugin.enabled
    ? t('workbench.plugins_disable_plugin', '停用插件')
    : t('workbench.plugins_enable_plugin', '启用插件')
  const logo = resolvePreferredPluginLogo({
    pluginKey: plugin.raw.spec.source.pluginKey,
    appearanceMode,
    interfaces: [plugin.raw.spec.interface, marketplaceItem?.interface],
  })
  const distributionLabel =
    plugin.distribution === 'official'
      ? t('workbench.plugins_distribution_official', 'OpenAI官方')
      : plugin.distribution === 'workspace'
        ? t('workbench.plugins_distribution_workspace', '企业内部')
        : plugin.distribution === 'personal'
          ? t('workbench.plugins_distribution_personal', '个人创建')
          : plugin.distribution === 'external'
            ? t('workbench.plugins_distribution_external', '第三方市场')
            : t('workbench.plugins_distribution_public', 'Wework官方')
  const subtitle = buildInstalledPluginSubtitle(plugin, marketplaceItem, t)
  const recoveryError = plugin.raw.spec.sourcePayload?.runtimeRecoveryError
  const needsRecovery = typeof recoveryError === 'string' && Boolean(recoveryError.trim())

  const mainContent = (
    <>
      <PluginSourceAvatar
        testId={`installed-plugin-logo-frame-${plugin.id}`}
        imageTestId={`installed-plugin-logo-${plugin.id}`}
        className={[
          'plugin-management-logo',
          logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
        ].join(' ')}
        contrastPad={logo.contrastPad}
        distribution={plugin.distribution}
        logoUrl={logo.url}
        name={plugin.name}
        useInitial={logo.source === 'fallback'}
      />
      <div className="min-w-0">
        <strong className="block truncate text-base font-medium leading-5 text-text-primary">
          {plugin.name}
          <span
            data-testid={`installed-plugin-origin-${plugin.id}`}
            title={plugin.sourceLabel}
            className={`plugin-management-pill ${distributionPillClass[plugin.distribution]}`}
          >
            {distributionLabel}
          </span>
          {plugin.updateAvailable && (
            <span className="plugin-management-pill plugin-management-pill-official">
              {t('workbench.plugins_update_available', '可更新')}
            </span>
          )}
        </strong>
        <small className="mt-0.5 block truncate text-sm leading-5 text-text-muted">
          {subtitle}
        </small>
        {needsRecovery && (
          <small
            role="status"
            data-testid={`installed-plugin-recovery-${plugin.id}`}
            title={recoveryError}
            className="block truncate text-sm leading-5 text-text-secondary"
          >
            {t('workbench.plugins_runtime_recovery_required')}
          </small>
        )}
      </div>
    </>
  )

  return (
    <article
      data-testid={`installed-plugin-row-${plugin.id}`}
      className="plugin-management-row grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4"
    >
      {onOpen ? (
        <ControlButton
          variant="unstyled"
          type="button"
          aria-label={`${t('workbench.plugins_view_plugin_detail', '查看 {{name}} 详情', { name: plugin.name })}`}
          className="grid min-h-[75px] grid-cols-[42px_minmax(0,1fr)] items-center gap-3 py-2 text-left focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus/30"
          onClick={onOpen}
        >
          {mainContent}
        </ControlButton>
      ) : (
        <div className="grid min-h-[75px] grid-cols-[42px_minmax(0,1fr)] items-center gap-3 py-2">
          {mainContent}
        </div>
      )}
      <div className="relative flex items-center gap-[7px]">
        {isUninstalling ? (
          <span
            role="status"
            data-testid={`installed-plugin-uninstalling-${plugin.id}`}
            className="inline-flex h-[30px] items-center gap-1.5 px-1.5 text-sm text-text-muted"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('workbench.plugins_uninstalling', '正在卸载')}
          </span>
        ) : onTry && !needsRecovery ? (
          <ControlButton
            variant="unstyled"
            type="button"
            aria-label={`${t('workbench.plugins_try_now', '立即对话')} ${plugin.name}`}
            title={t('workbench.plugins_try_now', '立即对话')}
            data-testid={`installed-plugin-try-${plugin.id}`}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
            onClick={onTry}
          >
            <MessageCirclePlus className="h-[17px] w-[17px]" strokeWidth={2} />
          </ControlButton>
        ) : null}
        {!isUninstalling && !shareRecipient && (
          <Switch
            checked={plugin.enabled}
            aria-label={`${toggleLabel} ${plugin.name}`}
            title={toggleLabel}
            data-testid={`installed-plugin-toggle-${plugin.id}`}
            onCheckedChange={onToggle}
          />
        )}
        {!isUninstalling && (
          <ActionMenu
            ariaLabel={t('workbench.plugins_more_actions', '更多操作') + ' ' + plugin.name}
            testId={`installed-plugin-actions-${plugin.id}`}
            menuTestId={`installed-plugin-actions-menu-${plugin.id}`}
            icon={Ellipsis}
            items={[
              ...(onShare
                ? [
                    {
                      testId: `installed-plugin-share-${plugin.id}`,
                      label: shareLabel || t('workbench.plugins_manage_access', '管理权限'),
                      icon: UserCog,
                      onSelect: onShare,
                    },
                  ]
                : []),
              ...(onPublish
                ? [
                    {
                      testId: `installed-plugin-publish-${plugin.id}`,
                      label: publishLabel || t('workbench.plugins_publish_to_marketplace', '发布'),
                      icon: Upload,
                      onSelect: onPublish,
                    },
                  ]
                : []),
              ...(onCopy
                ? [
                    {
                      testId: `installed-plugin-copy-${plugin.id}`,
                      label: t('workbench.plugins_copy_to_personal', '复制为个人插件'),
                      icon: Copy,
                      onSelect: onCopy,
                    },
                  ]
                : []),
              ...(onPublish || onShare || onCopy
                ? [{ id: 'uninstall-separator', label: '', separator: true }]
                : []),
              {
                testId: `installed-plugin-uninstall-${plugin.id}`,
                label: t('workbench.plugins_uninstall_plugin_action', '卸载插件'),
                icon: Trash2,
                danger: true,
                onSelect: onUninstall,
              },
            ]}
          />
        )}
      </div>
    </article>
  )
}
