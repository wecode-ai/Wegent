import { Boxes, MessageCirclePlus, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { InstalledPlugin } from '@/types/api'
import { resolvePluginAssetUrl } from './plugin-assets'
import type { PluginDistribution } from './pluginDistribution'

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

const distributionBadgeClass: Record<PluginDistribution, string> = {
  official: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  workspace: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  personal: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  public: 'bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
}

export function InstalledPluginRow({
  plugin,
  onOpen,
  onTry,
  onShare,
  onCopy,
  onToggle,
  onUninstall,
}: {
  plugin: InstalledPluginItem
  onOpen?: () => void
  onTry?: () => void
  onShare?: () => void
  onCopy?: () => void
  onToggle: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation('common')
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const toggleLabel = plugin.enabled
    ? t('workbench.plugins_disable_plugin', '停用插件')
    : t('workbench.plugins_enable_plugin', '启用插件')
  const logo = resolvePluginAssetUrl(
    plugin.raw.spec.interface?.logo || plugin.raw.spec.interface?.composerIcon
  )
  const componentLabels = Object.entries(plugin.componentCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)
  const distributionLabel =
    plugin.distribution === 'official'
      ? t('workbench.plugins_distribution_official', 'Codex 官方')
      : plugin.distribution === 'workspace'
        ? t('workbench.plugins_distribution_workspace', '企业内部')
        : plugin.distribution === 'personal'
          ? t('workbench.plugins_distribution_personal', '个人分享')
          : t('workbench.plugins_distribution_public', '国内公开')

  return (
    <article
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      data-testid={`installed-plugin-row-${plugin.id}`}
      className="grid min-h-[72px] cursor-pointer grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/30"
      onClick={onOpen}
      onKeyDown={event => {
        if (!onOpen) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[10px] border border-border bg-background">
        {logo ? (
          <img
            src={logo}
            alt=""
            data-testid={`installed-plugin-logo-${plugin.id}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <Boxes className="h-5 w-5 text-text-muted" />
        )}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-medium leading-5">{plugin.name}</h2>
          <span
            data-testid={`installed-plugin-origin-${plugin.id}`}
            title={plugin.sourceLabel}
            className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium leading-4 ${distributionBadgeClass[plugin.distribution]}`}
          >
            {distributionLabel}
          </span>
          {plugin.updateAvailable && (
            <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
              {t('workbench.plugins_update_available', '可更新')}
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-sm leading-5 text-text-secondary">
          {plugin.description || componentLabels.join(' · ')}
        </p>
      </div>
      <div className="flex items-center justify-end gap-1">
        {onTry && (
          <button
            type="button"
            aria-label={`${t('workbench.plugins_try_now', '立即试用')} ${plugin.name}`}
            title={t('workbench.plugins_try_now', '立即试用')}
            data-testid={`installed-plugin-try-${plugin.id}`}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-background hover:text-text-primary"
            onClick={event => {
              event.stopPropagation()
              onTry()
            }}
          >
            <MessageCirclePlus className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={plugin.enabled}
          aria-label={`${toggleLabel} ${plugin.name}`}
          title={toggleLabel}
          data-testid={`installed-plugin-toggle-${plugin.id}`}
          className={[
            'relative h-6 w-10 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40',
            plugin.enabled ? 'bg-emerald-500' : 'bg-border',
          ].join(' ')}
          onClick={event => {
            event.stopPropagation()
            onToggle()
          }}
        >
          <span
            className={[
              'absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
              plugin.enabled ? 'translate-x-4' : 'translate-x-0',
            ].join(' ')}
          />
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label={`${t('workbench.plugins_more_actions', '更多操作')} ${plugin.name}`}
            aria-expanded={isMenuOpen}
            data-testid={`installed-plugin-actions-${plugin.id}`}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-background hover:text-text-primary"
            onClick={event => {
              event.stopPropagation()
              setIsMenuOpen(open => !open)
            }}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {isMenuOpen && (
            <div
              data-testid={`installed-plugin-actions-menu-${plugin.id}`}
              className="absolute right-0 top-9 z-popover w-44 rounded-xl border border-border bg-popover p-1 shadow-xl"
              onClick={event => event.stopPropagation()}
            >
              {onShare && (
                <button
                  type="button"
                  data-testid={`installed-plugin-share-${plugin.id}`}
                  className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-text-primary hover:bg-surface"
                  onClick={() => {
                    setIsMenuOpen(false)
                    onShare()
                  }}
                >
                  {t('workbench.plugins_manage_access', '管理权限')}
                </button>
              )}
              {onCopy && (
                <button
                  type="button"
                  data-testid={`installed-plugin-copy-${plugin.id}`}
                  className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-text-primary hover:bg-surface"
                  onClick={() => {
                    setIsMenuOpen(false)
                    onCopy()
                  }}
                >
                  {t('workbench.plugins_copy_to_personal', '复制为个人插件')}
                </button>
              )}
              {(onShare || onCopy) && <div className="my-1 border-t border-border" />}
              <button
                type="button"
                data-testid={`installed-plugin-uninstall-${plugin.id}`}
                className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                onClick={() => {
                  setIsMenuOpen(false)
                  onUninstall()
                }}
              >
                {t('workbench.plugins_uninstall', '卸载')}
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
