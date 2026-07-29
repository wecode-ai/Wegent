import { ChevronLeft, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { notifyLocalPluginSkillsChanged, queuePluginTrial } from '@/features/plugins/pluginTrial'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type {
  InstalledPlugin,
  PluginAccessResponse,
  PluginAccessUpdateRequest,
  PluginMarketplaceItem,
} from '@/types/api'
import { InstalledPluginRow, type InstalledPluginItem } from './PluginManagementRows'
import {
  installedPluginSourceLabel,
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
} from './installedPluginMerge'
import { PluginDetailView } from './PluginDetailView'
import { PluginShareDialog } from './PluginShareDialog'
import { installedPluginDistribution } from './pluginDistribution'
import { getRuntimeConfig } from '@/config/runtime'

interface PluginShareState {
  plugin: PluginMarketplaceItem
  access: PluginAccessResponse
}

function toInstalledPluginItem(item: InstalledPlugin): InstalledPluginItem {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const components = item.spec.components
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : '',
    name: item.spec.displayName || item.spec.source.pluginKey,
    description: item.spec.description,
    enabled: item.spec.enabled,
    version: item.spec.version,
    origin: item.spec.origin ?? (item.spec.source.type === 'local' ? 'created' : 'market'),
    sourceLabel: installedPluginSourceLabel(item),
    distribution: installedPluginDistribution(item),
    updateAvailable: item.spec.installState === 'update_available',
    componentCounts: {
      skills: components.skills.length,
      apps: components.apps?.length ?? 0,
      commands: components.commands.length,
      agents: components.agents.length,
      mcp: components.mcps.length,
      connectors: components.connectors?.length ?? 0,
      hooks: components.hooks.length,
      lsp: components.lsps.length,
      monitors: components.monitors.length,
      bin: components.bins.length,
    },
    raw: item,
  }
}

function tryPluginInChat(plugin: InstalledPlugin) {
  queuePluginTrial(plugin)
  navigateTo('/')
}

interface PluginManagementWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  cloudApiBaseUrl?: string
  cloudToken?: string | null
}

export function PluginManagementWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudApiBaseUrl,
  cloudToken,
}: PluginManagementWorkspaceProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>([])
  const [marketplaceItems, setMarketplaceItems] = useState<PluginMarketplaceItem[]>([])
  const [isLoadingPlugins, setIsLoadingPlugins] = useState(true)
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const [pluginShareState, setPluginShareState] = useState<PluginShareState | null>(null)
  const [pluginShareSaving, setPluginShareSaving] = useState(false)
  const [pluginShareError, setPluginShareError] = useState<string | null>(null)
  const [pluginSharePreparing, setPluginSharePreparing] = useState(false)
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const runtime = getRuntimeConfig()
    return createPluginApi(
      createHttpClient({
        baseUrl: cloudApiBaseUrl || runtime.apiBaseUrl,
        ...(cloudToken === undefined
          ? {}
          : {
              getToken: () => cloudToken,
              redirectOnUnauthorized: false,
            }),
      })
    )
  }, [cloudApiBaseUrl, cloudToken])

  useEffect(() => {
    let current = true
    localPluginApi
      .readState()
      .then(async state => {
        const [cloudInstalled, marketplace] = await Promise.all([
          cloudPluginApi.listInstalledPlugins(state.deviceId).catch(() => ({ items: [] })),
          cloudPluginApi
            .listMarketplacePlugins({ deviceId: state.deviceId })
            .catch(() => ({ items: [] })),
        ])
        return { state, cloudInstalled, marketplace }
      })
      .then(({ state, cloudInstalled, marketplace }) => {
        if (!current) return
        setCurrentDeviceId(state.deviceId)
        setMarketplaceItems(marketplace.items)
        setInstalledPlugins(
          mergeInstalledPlugins(cloudInstalled.items, state.installedPlugins, state.deviceId).map(
            toInstalledPluginItem
          )
        )
      })
      .catch(() => {
        if (!current) return
        setInstalledPlugins([])
        setMarketplaceItems([])
      })
      .finally(() => {
        if (current) setIsLoadingPlugins(false)
      })
    return () => {
      current = false
    }
  }, [cloudPluginApi, localPluginApi])

  const filteredInstalledPlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return installedPlugins
    return installedPlugins.filter(plugin =>
      `${plugin.name} ${plugin.description} ${plugin.sourceLabel} ${Object.keys(
        plugin.componentCounts
      ).join(' ')}`
        .toLowerCase()
        .includes(normalizedQuery)
    )
  }, [installedPlugins, query])

  const marketplaceById = useMemo(
    () => new Map(marketplaceItems.map(item => [String(item.id), item])),
    [marketplaceItems]
  )
  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => String(plugin.id) === String(selectedPluginId)) ?? null),
    [installedPlugins, selectedPluginId]
  )

  const updateInstalledPlugin = (
    id: string | number,
    request: { enabled?: boolean; componentStates?: Record<string, boolean> }
  ) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return Promise.reject(new Error('Installed plugin not found'))
    return isCloudManagedInstalledPlugin(plugin.raw)
      ? cloudPluginApi.updateInstalledPlugin(id, request, currentDeviceId || undefined)
      : localPluginApi.updateInstalledPlugin(id, request)
  }

  const toggleInstalledPlugin = (id: string | number) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    setInstalledPlugins(previous =>
      previous.map(item =>
        String(item.id) === String(id) ? { ...item, enabled: !item.enabled } : item
      )
    )
    void updateInstalledPlugin(id, { enabled: !plugin.enabled })
      .then(updated => {
        setInstalledPlugins(previous =>
          previous.map(item =>
            String(item.id) === String(id) ? toInstalledPluginItem(updated) : item
          )
        )
        notifyLocalPluginSkillsChanged()
      })
      .catch(() => {
        setInstalledPlugins(previous =>
          previous.map(item =>
            String(item.id) === String(id) ? { ...item, enabled: plugin.enabled } : item
          )
        )
      })
  }

  const togglePluginComponent = (id: string | number, componentKey: string, enabled: boolean) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    const previousStates = plugin.raw.spec.componentStates || {}
    setInstalledPlugins(previous =>
      previous.map(item =>
        String(item.id) === String(id)
          ? {
              ...item,
              raw: {
                ...item.raw,
                spec: {
                  ...item.raw.spec,
                  componentStates: { ...previousStates, [componentKey]: enabled },
                },
              },
            }
          : item
      )
    )
    void updateInstalledPlugin(id, { componentStates: { [componentKey]: enabled } })
      .then(updated => {
        setInstalledPlugins(previous =>
          previous.map(item =>
            String(item.id) === String(id) ? toInstalledPluginItem(updated) : item
          )
        )
      })
      .catch(() => {
        setInstalledPlugins(previous =>
          previous.map(item => (String(item.id) === String(id) ? plugin : item))
        )
      })
  }

  const uninstallInstalledPlugin = (id: string | number) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    setInstalledPlugins(previous => previous.filter(item => String(item.id) !== String(id)))
    setSelectedPluginId(current => (String(current) === String(id) ? null : current))
    const request = isCloudManagedInstalledPlugin(plugin.raw)
      ? cloudPluginApi.uninstallInstalledPlugin(id, currentDeviceId || undefined)
      : localPluginApi.uninstallInstalledPlugin(id)
    void request
      .then(() => notifyLocalPluginSkillsChanged())
      .catch(() => setInstalledPlugins(previous => [...previous, plugin]))
  }

  const shareInstalledPlugin = async (plugin: InstalledPluginItem) => {
    setPluginSharePreparing(true)
    setPluginShareError(null)
    try {
      const slug = plugin.raw.spec.source.pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
      let personalPlugin = marketplaceItems.find(
        item => item.accessRole === 'owner' && (item.name === slug || item.name === plugin.name)
      )
      if (!personalPlugin) {
        const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
        const components = plugin.raw.spec.components
        const listingType =
          components.skills.length === 1 &&
          components.commands.length === 0 &&
          components.agents.length === 0 &&
          components.mcps.length === 0 &&
          components.hooks.length === 0
            ? 'skill'
            : 'plugin'
        const completed = await cloudPluginApi.publishSubmission(file, {
          slug,
          displayName: plugin.name,
          version: plugin.version || '0.1.0',
          listingType,
          purpose: 'restricted_share',
        })
        personalPlugin = completed.plugin ?? undefined
      }
      if (!personalPlugin?.latestReleaseId) {
        throw new Error('Personal plugin release mapping is unavailable')
      }
      await localPluginApi.linkPersonalPluginRelease(
        plugin.raw,
        Number(personalPlugin.id),
        personalPlugin.latestReleaseId
      )
      const access = await cloudPluginApi.getMarketplacePluginAccess(personalPlugin.id)
      setPluginShareState({ plugin: personalPlugin, access })
    } catch (error) {
      setPluginShareError(error instanceof Error ? error.message : 'Failed to prepare sharing')
    } finally {
      setPluginSharePreparing(false)
    }
  }

  const copyMarketplacePlugin = async (plugin: PluginMarketplaceItem) => {
    setPluginSharePreparing(true)
    try {
      const descriptor = await cloudPluginApi.copyMarketplacePlugin(plugin.id)
      const installed = await localPluginApi.importMarketplaceCopy(descriptor)
      const item = toInstalledPluginItem(installed)
      setInstalledPlugins(previous => [
        item,
        ...previous.filter(candidate => String(candidate.id) !== String(item.id)),
      ])
      notifyLocalPluginSkillsChanged()
      setSelectedPluginId(item.id)
    } finally {
      setPluginSharePreparing(false)
    }
  }

  const savePluginShare = async (request: PluginAccessUpdateRequest) => {
    if (!pluginShareState) return
    setPluginShareSaving(true)
    setPluginShareError(null)
    try {
      const access = await cloudPluginApi.updateMarketplacePluginAccess(
        pluginShareState.plugin.id,
        request
      )
      setMarketplaceItems(previous =>
        previous.map(item =>
          item.id === pluginShareState.plugin.id
            ? {
                ...item,
                allowCopy: access.allowCopy,
                grantUserCount: access.targets.filter(target => target.entityType === 'user')
                  .length,
                grantNamespaceCount: access.targets.filter(
                  target => target.entityType === 'namespace'
                ).length,
              }
            : item
        )
      )
      setPluginShareState(null)
    } catch (error) {
      setPluginShareError(error instanceof Error ? error.message : 'Failed to save plugin access')
    } finally {
      setPluginShareSaving(false)
    }
  }

  const searchPluginShareUsers = useCallback(
    (value: string) =>
      cloudPluginApi.searchPluginShareUsers(value).then(response => response.users),
    [cloudPluginApi]
  )
  const searchPluginShareGroups = useCallback(
    (value: string) =>
      cloudPluginApi.searchPluginShareGroups(value).then(response => response.items),
    [cloudPluginApi]
  )

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

  if (selectedPlugin) {
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          tertiaryActionLabel={
            selectedPlugin.origin === 'created' ? t('workbench.plugins_share', '分享') : undefined
          }
          tertiaryActionDisabled={pluginSharePreparing}
          onTertiaryAction={
            selectedPlugin.origin === 'created'
              ? () => void shareInstalledPlugin(selectedPlugin)
              : undefined
          }
          onBack={() => setSelectedPluginId(null)}
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            selectedPlugin.origin === 'created'
              ? () =>
                  navigateTo(
                    `/plugins/create?edit=${encodeURIComponent(
                      selectedPlugin.raw.spec.source.pluginKey
                    )}`
                  )
              : undefined
          }
          onToggle={() => tryPluginInChat(selectedPlugin.raw)}
          onComponentToggle={(componentKey, enabled) =>
            togglePluginComponent(selectedPlugin.id, componentKey, enabled)
          }
          onUninstall={() => uninstallInstalledPlugin(selectedPlugin.id)}
        />
        {pluginShareDialog}
      </>
    )
  }

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background text-text-primary">
      <DesktopTopBar
        testId="plugin-management-topbar"
        className={[
          'sticky top-0 z-30 h-12 bg-background/95 pl-20 pr-4 backdrop-blur-xl md:h-[52px] md:pr-7',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
        ].join(' ')}
        left={
          <>
            {topBarLeftActions}
            <button
              type="button"
              data-testid="plugin-management-back-button"
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary hover:bg-surface hover:text-text-primary"
              onClick={() => navigateTo('/plugins')}
            >
              <ChevronLeft className="h-4 w-4" />
              {t('workbench.plugins_back_to_marketplace', '返回插件市场')}
            </button>
          </>
        }
      />

      <section className="mx-auto flex w-full max-w-[1060px] flex-col gap-6 px-5 pb-12 pt-8 md:px-8 md:pt-10">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1.5">
            <h1 className="heading-medium text-text-primary">
              {t('workbench.plugins_manage_plugins', '管理插件')}
            </h1>
            <p className="text-sm text-text-secondary">
              {t('workbench.plugins_manage_plugins_description', '管理已安装插件。')}
            </p>
          </div>
          <label className="relative w-full shrink-0 md:w-[320px]">
            <span className="sr-only">{t('workbench.plugins_search_plugins', '搜索插件')}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('workbench.plugins_search_plugins', '搜索插件')}
              data-testid="plugin-management-search-input"
              className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
            />
          </label>
        </header>

        {isLoadingPlugins ? (
          <div className="py-10 text-sm text-text-secondary">
            {t('workbench.plugins_loading_plugins', '正在加载插件')}
          </div>
        ) : filteredInstalledPlugins.length > 0 ? (
          <div
            data-testid="plugin-management-installed-list"
            className="divide-y divide-border overflow-hidden rounded-xl border border-border"
          >
            {filteredInstalledPlugins.map(plugin => {
              const marketplaceItem = plugin.raw.spec.pluginId
                ? marketplaceById.get(String(plugin.raw.spec.pluginId))
                : undefined
              return (
                <InstalledPluginRow
                  key={plugin.id}
                  plugin={plugin}
                  onOpen={() => setSelectedPluginId(plugin.id)}
                  onTry={() => tryPluginInChat(plugin.raw)}
                  onShare={
                    plugin.origin === 'created'
                      ? () => void shareInstalledPlugin(plugin)
                      : undefined
                  }
                  onCopy={
                    marketplaceItem?.accessRole === 'recipient' && marketplaceItem.allowCopy
                      ? () => void copyMarketplacePlugin(marketplaceItem)
                      : undefined
                  }
                  onToggle={() => toggleInstalledPlugin(plugin.id)}
                  onUninstall={() => uninstallInstalledPlugin(plugin.id)}
                />
              )
            })}
          </div>
        ) : query ? (
          <div className="py-10 text-sm text-text-secondary">
            {t('workbench.plugins_no_search_results', '没有匹配的插件')}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 py-10 text-sm text-text-secondary">
            <strong className="font-medium text-text-primary">
              {t('workbench.plugins_no_installed_plugins', '还没有安装插件')}
            </strong>
            <span>
              {t('workbench.plugins_no_installed_plugins_hint', '安装后的插件会集中显示在这里。')}
            </span>
            <button
              type="button"
              data-testid="plugin-management-browse-marketplace-button"
              className="mt-2 h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90"
              onClick={() => navigateTo('/plugins')}
            >
              {t('workbench.plugins_browse_marketplace', '浏览插件市场')}
            </button>
          </div>
        )}
      </section>
      {pluginShareDialog}
    </main>
  )
}
