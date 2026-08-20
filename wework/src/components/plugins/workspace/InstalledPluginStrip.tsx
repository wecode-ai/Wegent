import { memo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { useOptionalAppearance } from '@/features/appearance'
import type { PluginMarketplaceItem } from '@/types/api'
import { findMarketplaceItemForInstalled } from '../findMarketplaceItemForInstalled'
import { resolvePreferredPluginLogo } from '../plugin-assets'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { PluginSourceAvatar } from '../PluginSourceAvatar'
import { INSTALLED_STRIP_OVERFLOW_PREVIEW_COUNT } from './marketplaceWorkspaceHelpers'

export const InstalledPluginStrip = memo(function InstalledPluginStrip({
  plugins,
  hiddenPlugins,
  marketplaceItems,
  sidebarCollapsed,
  onOpen,
}: {
  plugins: InstalledPluginItem[]
  hiddenPlugins: InstalledPluginItem[]
  marketplaceItems: PluginMarketplaceItem[]
  sidebarCollapsed: boolean
  onOpen: (plugin: InstalledPluginItem) => void
}) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'

  return (
    <section className="plugin-installed-strip" data-testid="plugins-installed-strip">
      <div className="plugin-installed-strip-head">
        <h2>{t('workbench.plugins_installed', '已安装')}</h2>
      </div>
      <div className={['-mx-5 md:-mr-10', sidebarCollapsed ? 'md:-ml-6' : 'md:-ml-7'].join(' ')}>
        <div
          className={[
            'plugin-installed-icons-scroller',
            'px-5 md:pr-10',
            sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          ].join(' ')}
          data-testid="plugins-installed-scroll-region"
          role="region"
          aria-label={t('workbench.plugins_installed', '已安装')}
        >
          <div className="plugin-installed-icons-track">
            {plugins.map(plugin => {
              const marketplaceItem = findMarketplaceItemForInstalled(plugin, marketplaceItems)
              const logo = resolvePreferredPluginLogo({
                pluginKey: String(plugin.raw.spec.source?.pluginKey || plugin.id),
                appearanceMode,
                interfaces: [plugin.raw.spec.interface, marketplaceItem?.interface],
              })
              return (
                <button
                  key={plugin.id}
                  type="button"
                  data-testid={`plugins-installed-strip-item-${plugin.id}`}
                  data-tooltip={plugin.name}
                  aria-label={plugin.name}
                  className="plugin-installed-strip-item"
                  onClick={() => onOpen(plugin)}
                >
                  <PluginSourceAvatar
                    className={[
                      'plugin-installed-strip-logo',
                      logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
                    ].join(' ')}
                    contrastPad={logo.contrastPad}
                    distribution={plugin.distribution}
                    logoUrl={logo.url}
                    name={plugin.name}
                    useInitial={logo.source === 'fallback'}
                  />
                </button>
              )
            })}
            {hiddenPlugins.length > 0 && (
              <button
                type="button"
                data-testid="plugins-installed-overflow-button"
                className="plugin-installed-overflow-button"
                aria-label={t(
                  'workbench.plugins_view_more_installed',
                  '查看另外 {{count}} 个已安装插件',
                  { count: hiddenPlugins.length }
                )}
                onClick={() => navigateTo('/plugins/manage')}
              >
                <span className="plugin-installed-overflow-preview" aria-hidden="true">
                  {hiddenPlugins.slice(0, INSTALLED_STRIP_OVERFLOW_PREVIEW_COUNT).map(plugin => {
                    const marketplaceItem = findMarketplaceItemForInstalled(
                      plugin,
                      marketplaceItems
                    )
                    const logo = resolvePreferredPluginLogo({
                      pluginKey: String(plugin.raw.spec.source?.pluginKey || plugin.id),
                      appearanceMode,
                      interfaces: [plugin.raw.spec.interface, marketplaceItem?.interface],
                    })
                    return (
                      <PluginSourceAvatar
                        key={plugin.id}
                        className="plugin-installed-overflow-preview-logo"
                        contrastPad={logo.contrastPad}
                        distribution={plugin.distribution}
                        logoUrl={logo.url}
                        name={plugin.name}
                        useInitial={logo.source === 'fallback'}
                      />
                    )
                  })}
                </span>
                <span className="plugin-installed-overflow-label">
                  {t('workbench.plugins_more_installed_count', '另有 {{count}} 个', {
                    count: hiddenPlugins.length,
                  })}
                </span>
              </button>
            )}
            {plugins.length === 0 && (
              <span data-testid="plugins-installed-strip-empty" className="text-sm text-text-muted">
                {t('workbench.plugins_no_installed_in_filter', '当前筛选下没有已安装插件')}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  )
})
