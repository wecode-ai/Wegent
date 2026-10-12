import { Loader2, Plug, Search } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginMarketplaceItem, RuntimeProjectPluginRef } from '@/types/api'
import type { ProjectPluginSupport } from '@/lib/project-editing-capabilities'
import {
  marketplacePluginLockLabel,
  resolveMarketplacePluginLock,
} from '../plugins/marketplacePluginLock'

interface ProjectPluginSettingsPanelProps {
  projectPlugins: RuntimeProjectPluginRef[]
  pluginItems: PluginMarketplaceItem[]
  filteredPluginItems: PluginMarketplaceItem[]
  pluginSearch: string
  pluginsPending: boolean
  pluginsDisabled: boolean
  searchDisabled: boolean
  pluginSupport: ProjectPluginSupport
  aiSettingsSupported: boolean
  offline: boolean
  installingPluginId: string | null
  apiAvailable: boolean
  onSearch: (query: string) => void
  onRemove: (id: string) => void
  onInstall: (item: PluginMarketplaceItem) => void
}

export function ProjectPluginSettingsPanel({
  projectPlugins,
  pluginItems,
  filteredPluginItems,
  pluginSearch,
  pluginsPending,
  pluginsDisabled,
  searchDisabled,
  pluginSupport,
  aiSettingsSupported,
  offline,
  installingPluginId,
  apiAvailable,
  onSearch,
  onRemove,
  onInstall,
}: ProjectPluginSettingsPanelProps) {
  const { t } = useTranslation('common')
  return (
    <div data-testid="local-project-settings-plugins-panel">
      {!offline && (pluginSupport === 'unsupported' || !aiSettingsSupported) && (
        <p data-testid="project-plugins-upgrade-hint" className="mt-3 text-sm text-text-secondary">
          {t('workbench.project_plugins_upgrade_required')}
        </p>
      )}
      {pluginSupport === 'unknown' && pluginsPending && (
        <p
          data-testid="project-plugins-capability-pending"
          className="mt-3 text-sm text-text-secondary"
        >
          {t('workbench.project_plugins_support_pending')}
        </p>
      )}
      <p className="mt-5 text-sm text-text-secondary">
        {t(
          'workbench.project_plugins_description',
          '安装到此项目的插件只会在该项目的新对话中加载。插件包缓存可复用，但不会自动出现在其他项目。'
        )}
      </p>
      <label className="mt-4 flex h-10 items-center rounded-xl border border-border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
        <Search className="mx-3 h-4 w-4 shrink-0 text-text-secondary" />
        <input
          data-testid="local-project-plugin-search"
          value={pluginSearch}
          disabled={searchDisabled}
          onChange={event => onSearch(event.target.value)}
          placeholder={t('workbench.project_plugins_search_placeholder', '搜索插件市场')}
          className="min-w-0 flex-1 bg-transparent pr-3 text-base outline-none"
        />
      </label>
      <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-border bg-background">
        {projectPlugins
          .filter(
            plugin =>
              !pluginItems.some(
                item =>
                  item.name === plugin.pluginName &&
                  item.manifest.marketplaceId === plugin.marketplaceId
              )
          )
          .map(plugin => (
            <div
              key={plugin.id}
              data-testid={`project-selected-plugin-${plugin.id}`}
              className="flex items-center justify-between gap-3 py-2 text-base"
            >
              <span>{plugin.displayName || plugin.pluginName}</span>
              <button
                type="button"
                data-testid={`remove-project-selected-plugin-${plugin.id}`}
                disabled={pluginsDisabled}
                onClick={() => onRemove(plugin.id)}
                className="rounded-lg bg-muted px-3 py-1 text-sm disabled:opacity-50"
              >
                {t('workbench.project_plugin_remove', '从项目移除')}
              </button>
            </div>
          ))}
        {pluginsPending ? (
          <div
            data-testid="local-project-plugins-loading"
            className="flex h-20 items-center justify-center gap-2 text-sm text-text-secondary"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('workbench.loading', '加载中...')}
          </div>
        ) : filteredPluginItems.length > 0 ? (
          filteredPluginItems.map(item => {
            const marketplaceId =
              typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId : ''
            const projectPluginId = `${item.name}@${marketplaceId}`
            const installedForProject = projectPlugins.some(plugin => plugin.id === projectPluginId)
            const installing = installingPluginId === projectPluginId
            const installLock = installedForProject ? null : resolveMarketplacePluginLock(item)
            return (
              <div
                key={`${marketplaceId}:${item.id}`}
                data-testid={`local-project-plugin-row-${item.name}`}
                className="flex min-h-14 items-center gap-3 border-b border-border px-3 last:border-b-0"
              >
                <Plug className="h-4 w-4 shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1 py-2">
                  <div className="truncate text-base">{item.displayName || item.name}</div>
                  <div className="truncate text-sm text-text-secondary">
                    {item.sourceLabel || marketplaceId}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid={`local-project-plugin-toggle-${item.name}`}
                  disabled={pluginsDisabled || installing || !marketplaceId || Boolean(installLock)}
                  onClick={() => {
                    if (installedForProject) {
                      onRemove(projectPluginId)
                      return
                    }
                    onInstall(item)
                  }}
                  className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm hover:bg-border disabled:opacity-50"
                >
                  {installing && <Loader2 className="h-4 w-4 animate-spin" />}
                  {installedForProject
                    ? t('workbench.project_plugin_remove', '移出项目')
                    : installLock
                      ? marketplacePluginLockLabel(installLock, t)
                      : t('workbench.project_plugin_install', '安装到项目')}
                </button>
              </div>
            )
          })
        ) : (
          <div className="flex h-20 items-center justify-center text-sm text-text-secondary">
            {apiAvailable
              ? t('workbench.project_plugins_empty', '没有匹配的插件')
              : t('workbench.project_plugins_unavailable', '插件市场当前不可用')}
          </div>
        )}
      </div>
    </div>
  )
}
