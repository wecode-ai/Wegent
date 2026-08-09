import { Copy, Ellipsis, Loader2, MessageCirclePlus, Trash2, Upload, UserCog } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { resolvePluginLogo } from './plugin-assets'
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
  onShare,
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
  onShare?: () => void
  onCopy?: () => void
  onToggle: () => void
  onUninstall: () => void
  isUninstalling?: boolean
}) {
  const { t } = useTranslation('common')
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const shareRecipient = marketplaceItem?.accessRole === 'recipient'
  const toggleLabel = plugin.enabled
    ? t('workbench.plugins_disable_plugin', '停用插件')
    : t('workbench.plugins_enable_plugin', '启用插件')
  const logo = resolvePluginLogo({
    pluginKey: plugin.raw.spec.source.pluginKey,
    logo: plugin.raw.spec.interface?.logo,
    composerIcon: plugin.raw.spec.interface?.composerIcon,
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

  useEffect(() => {
    if (!isMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [isMenuOpen])

  const mainContent = (
    <>
      <PluginSourceAvatar
        className={[
          'plugin-management-logo',
          logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
        ].join(' ')}
        distribution={plugin.distribution}
        imageTestId={`installed-plugin-logo-${plugin.id}`}
        invertLogoInDark={logo.invertInDark}
        logoUrl={logo.url}
        name={plugin.name}
        testId={`installed-plugin-logo-frame-${plugin.id}`}
        useInitial={logo.isGenericFallback}
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
      </div>
    </>
  )

  return (
    <article
      data-testid={`installed-plugin-row-${plugin.id}`}
      className="plugin-management-row grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4"
    >
      {onOpen ? (
        <button
          type="button"
          aria-label={`${t('workbench.plugins_view_plugin_detail', '查看 {{name}} 详情', { name: plugin.name })}`}
          className="grid min-h-[75px] grid-cols-[42px_minmax(0,1fr)] items-center gap-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/30"
          onClick={onOpen}
        >
          {mainContent}
        </button>
      ) : (
        <div className="grid min-h-[75px] grid-cols-[42px_minmax(0,1fr)] items-center gap-3 py-2">
          {mainContent}
        </div>
      )}
      <div ref={actionsRef} className="relative flex items-center gap-[7px]">
        {isUninstalling ? (
          <span
            role="status"
            data-testid={`installed-plugin-uninstalling-${plugin.id}`}
            className="inline-flex h-[30px] items-center gap-1.5 px-1.5 text-sm text-text-muted"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('workbench.plugins_uninstalling', '正在卸载')}
          </span>
        ) : onTry ? (
          <button
            type="button"
            aria-label={`${t('workbench.plugins_try_now', '立即对话')} ${plugin.name}`}
            title={t('workbench.plugins_try_now', '立即对话')}
            data-testid={`installed-plugin-try-${plugin.id}`}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
            onClick={onTry}
          >
            <MessageCirclePlus className="h-[17px] w-[17px]" strokeWidth={2} />
          </button>
        ) : null}
        {!isUninstalling && !shareRecipient && (
          <button
            type="button"
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${toggleLabel} ${plugin.name}`}
            title={toggleLabel}
            data-testid={`installed-plugin-toggle-${plugin.id}`}
            className={[
              'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40',
              plugin.enabled ? 'bg-emerald-600' : 'bg-border',
            ].join(' ')}
            onClick={onToggle}
          >
            <span
              className={[
                'absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                plugin.enabled ? 'translate-x-4' : 'translate-x-0',
              ].join(' ')}
            />
          </button>
        )}
        {!isUninstalling && (
          <button
            type="button"
            aria-label={`${t('workbench.plugins_more_actions', '更多操作')} ${plugin.name}`}
            aria-expanded={isMenuOpen}
            title={t('workbench.plugins_more_actions', '更多操作')}
            data-testid={`installed-plugin-actions-${plugin.id}`}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
            onClick={() => setIsMenuOpen(open => !open)}
          >
            <Ellipsis className="h-[17px] w-[17px]" strokeWidth={2} />
          </button>
        )}
        {!isUninstalling && isMenuOpen && (
          <div
            data-testid={`installed-plugin-actions-menu-${plugin.id}`}
            className="absolute right-0 top-[calc(100%+7px)] z-popover min-w-[172px] rounded-xl border border-border/30 bg-popover p-1 shadow-lg"
          >
            {onPublish && (
              <button
                type="button"
                data-testid={`installed-plugin-publish-${plugin.id}`}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-base text-text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
                onClick={() => {
                  setIsMenuOpen(false)
                  onPublish()
                }}
              >
                <Upload className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
                {t('workbench.plugins_publish_to_marketplace', '发布')}
              </button>
            )}
            {onShare && (
              <button
                type="button"
                data-testid={`installed-plugin-share-${plugin.id}`}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-base text-text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
                onClick={() => {
                  setIsMenuOpen(false)
                  onShare()
                }}
              >
                <UserCog className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
                {t('workbench.plugins_manage_access', '管理权限')}
              </button>
            )}
            {onCopy && (
              <button
                type="button"
                data-testid={`installed-plugin-copy-${plugin.id}`}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-base text-text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
                onClick={() => {
                  setIsMenuOpen(false)
                  onCopy()
                }}
              >
                <Copy className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
                {t('workbench.plugins_copy_to_personal', '复制为个人插件')}
              </button>
            )}
            {(onPublish || onShare || onCopy) && <div className="my-1 h-px bg-border/25" />}
            <button
              type="button"
              data-testid={`installed-plugin-uninstall-${plugin.id}`}
              className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-base text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/20 dark:hover:bg-red-950/30"
              onClick={() => {
                setIsMenuOpen(false)
                onUninstall()
              }}
            >
              <Trash2 className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
              {t('workbench.plugins_uninstall_plugin_action', '卸载插件')}
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
