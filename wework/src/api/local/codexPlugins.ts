import { isTauriRuntime } from '@/lib/runtime-environment'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import type {
  InstalledPlugin,
  InstalledPluginComponents,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
  LocalDeviceApp,
  LocalDeviceSkill,
  PluginInterface,
  PluginMarketplaceItem,
  PluginMarketplaceListResponse,
} from '@/types/api'

export interface LocalCodexPluginsState {
  marketplaceItems: PluginMarketplaceItem[]
  installedPlugins: InstalledPlugin[]
  marketplaces: LocalCodexMarketplace[]
  selectedMarketplaceId: string
  marketplacePath: string
  installRegistryPath: string
}

export interface LocalCodexMarketplace {
  id: string
  name: string
  path: string
}

export interface LocalCodexPluginApi {
  readState(params?: {
    q?: string
    marketplaceId?: string
    refresh?: boolean
  }): Promise<LocalCodexPluginsState>
  listInstalledPlugins(): Promise<InstalledPluginListResponse>
  listSkills(params?: { cwds?: string[]; forceReload?: boolean }): Promise<LocalDeviceSkill[]>
  listApps(params?: { forceRefetch?: boolean }): Promise<LocalDeviceApp[]>
  listAvailablePlugins(params?: {
    q?: string
    marketplaceId?: string
    refresh?: boolean
  }): Promise<PluginMarketplaceListResponse>
  selectMarketplace(id: string): Promise<LocalCodexPluginsState>
  deleteMarketplace(id: string): Promise<LocalCodexPluginsState>
  reorderMarketplaces(ids: string[]): Promise<LocalCodexPluginsState>
  upsertMarketplace(data: {
    id?: string
    name: string
    path: string
  }): Promise<LocalCodexPluginsState>
  installAvailablePlugin(pluginId: string | number): Promise<InstalledPlugin>
  updateInstalledPlugin(
    id: string | number,
    data: InstalledPluginUpdateRequest
  ): Promise<InstalledPlugin>
  uninstallInstalledPlugin(id: string | number): Promise<void>
}

const emptyState: LocalCodexPluginsState = {
  marketplaceItems: [],
  installedPlugins: [],
  marketplaces: [],
  selectedMarketplaceId: '',
  marketplacePath: '',
  installRegistryPath: '',
}

interface CodexPluginMarketplaceEntry {
  name: string
  path?: string | null
  interface?: {
    displayName?: string | null
  } | null
  plugins: CodexPluginSummary[]
}

export interface CodexPluginSummary {
  id: string
  remotePluginId?: string | null
  localVersion?: string | null
  name: string
  source?: Record<string, unknown>
  installed: boolean
  enabled: boolean
  installPolicy?: string
  authPolicy?: string
  availability?: string
  interface?: PluginInterface | null
  keywords?: string[]
}

interface CodexPluginDetail {
  marketplaceName: string
  marketplacePath?: string | null
  summary: CodexPluginSummary
  description?: string | null
  skills?: Array<{
    name: string
    description?: string | null
    shortDescription?: string | null
    path?: string | null
    enabled: boolean
  }>
  hooks?: Array<{ key: string; eventName?: string }>
  apps?: Array<{ id: string; name: string; description?: string | null }>
  appTemplates?: Array<{ templateId: string; name: string; description?: string | null }>
  mcpServers?: string[]
}

interface CodexAppInfo {
  id: string
  name: string
  description?: string | null
  logoUrl?: string | null
  installUrl?: string | null
  isAccessible?: boolean
  isEnabled?: boolean
  pluginDisplayNames?: string[]
}

interface CodexSkillMetadata {
  name: string
  description: string
  shortDescription?: string | null
  short_description?: string | null
  path: string
  scope: string
  enabled: boolean
  interface?: {
    displayName?: string | null
    shortDescription?: string | null
    short_description?: string | null
  } | null
}

interface CodexSkillsListEntry {
  cwd: string
  skills: CodexSkillMetadata[]
  errors?: Array<{ path: string; message: string }>
}

const SELECTED_MARKETPLACE_STORAGE_KEY = 'wework.plugins.selectedCodexMarketplace'

let cachedState: LocalCodexPluginsState | null = null

async function codexAppServerRequest<T>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureLocalExecutorStarted()
  return requestLocalExecutor<T>('codex.app_server_request', {
    method,
    params,
  })
}

function selectedMarketplaceId(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(SELECTED_MARKETPLACE_STORAGE_KEY) ?? ''
}

function installedPluginId(plugin: InstalledPlugin): unknown {
  const labels = plugin.metadata.labels
  if (!labels || typeof labels !== 'object') return null
  return (labels as Record<string, unknown>).id
}

function isLocalMarketplacePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

function pluginInstallName(item: PluginMarketplaceItem, localMarketplace: boolean): string {
  if (localMarketplace) return item.name
  return item.remotePluginId || String(item.id)
}

function rememberSelectedMarketplaceId(id: string) {
  if (typeof window === 'undefined') return
  if (id) {
    window.localStorage.setItem(SELECTED_MARKETPLACE_STORAGE_KEY, id)
  } else {
    window.localStorage.removeItem(SELECTED_MARKETPLACE_STORAGE_KEY)
  }
}

function emptyComponents(): InstalledPluginComponents {
  return {
    skills: [],
    commands: [],
    apps: [],
    agents: [],
    mcps: [],
    hooks: [],
    lsps: [],
    monitors: [],
    bins: [],
  }
}

function pluginDescription(summary: CodexPluginSummary, detail?: CodexPluginDetail | null): string {
  return (
    detail?.description?.trim() ||
    summary.interface?.shortDescription?.trim() ||
    summary.interface?.longDescription?.trim() ||
    ''
  )
}

function pluginDisplayName(summary: CodexPluginSummary): string {
  return summary.interface?.displayName?.trim() || summary.name
}

function sourcePayload(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary
): Record<string, unknown> {
  return {
    marketplaceName: marketplace.name,
    marketplacePath: marketplace.path ?? null,
    pluginName: plugin.name,
    pluginId: plugin.id,
    remotePluginId: plugin.remotePluginId ?? null,
  }
}

function pluginComponents(detail?: CodexPluginDetail | null): InstalledPluginComponents {
  const components = emptyComponents()
  if (!detail) return components
  components.skills = (detail.skills ?? []).map(skill => ({
    name: skill.name,
    description: skill.shortDescription || skill.description || '',
    path: skill.path || skill.name,
  }))
  components.hooks = (detail.hooks ?? []).map(hook => ({
    name: hook.key,
    path: hook.key,
  }))
  components.mcps = (detail.mcpServers ?? []).map(name => ({
    name,
    server: {},
  }))
  components.apps = (detail.apps ?? []).map(app => ({
    name: app.name,
    path: app.id,
  }))
  components.commands = [
    ...(detail.appTemplates ?? []).map(template => ({
      name: template.name,
      path: template.templateId,
    })),
  ]
  return components
}

function marketplaceInfo(marketplace: CodexPluginMarketplaceEntry): LocalCodexMarketplace {
  return {
    id: marketplace.name,
    name: marketplace.interface?.displayName?.trim() || marketplace.name,
    path: marketplace.path ?? marketplace.name,
  }
}

function toLocalDeviceApp(app: CodexAppInfo): LocalDeviceApp {
  return {
    id: app.id,
    name: app.name,
    description: app.description ?? null,
    logoUrl: app.logoUrl ?? null,
    installUrl: app.installUrl ?? null,
    isAccessible: app.isAccessible,
    isEnabled: app.isEnabled,
    pluginDisplayNames: app.pluginDisplayNames ?? [],
    source: 'codex-app',
  }
}

function toLocalDeviceSkill(skill: CodexSkillMetadata): LocalDeviceSkill {
  return {
    name: skill.name,
    description:
      skill.interface?.shortDescription ||
      skill.interface?.short_description ||
      skill.shortDescription ||
      skill.short_description ||
      skill.description ||
      '',
    short_description:
      skill.interface?.shortDescription ||
      skill.interface?.short_description ||
      skill.shortDescription ||
      skill.short_description ||
      null,
    path: skill.path,
    source: 'codex',
    scope: skill.scope,
    source_label: null,
    source_priority: skill.scope === 'system' || skill.scope === 'admin' ? 1 : 0,
    origin: 'local',
  }
}

function toMarketplaceItem(
  _marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): PluginMarketplaceItem {
  const components = pluginComponents(detail)
  return {
    id: plugin.id,
    remotePluginId: plugin.remotePluginId ?? plugin.id,
    name: plugin.name,
    displayName: pluginDisplayName(plugin),
    description: pluginDescription(plugin, detail),
    version: plugin.localVersion ?? null,
    author: plugin.interface?.developerName ?? null,
    visibility: 'personal',
    featured: false,
    installed: plugin.installed,
    installedPluginId: plugin.installed ? plugin.id : null,
    enabled: plugin.enabled,
    sourceType: 'marketplace',
    interface: plugin.interface ?? null,
    components,
    manifest: {
      name: plugin.name,
      id: plugin.id,
      source: plugin.source ?? null,
      installPolicy: plugin.installPolicy ?? null,
      authPolicy: plugin.authPolicy ?? null,
      availability: plugin.availability ?? null,
    },
    ownerUserId: 0,
  }
}

function toInstalledPlugin(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): InstalledPlugin {
  const components = pluginComponents(detail)
  const skillStates = Object.fromEntries(
    (detail?.skills ?? []).map(skill => [`skill:${skill.name}`, skill.enabled])
  )
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: plugin.name,
      namespace: marketplace.name,
      labels: { id: plugin.id },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: marketplace.name,
        pluginKey: plugin.name,
        catalogItemId: plugin.remotePluginId ?? plugin.id,
      },
      displayName: pluginDisplayName(plugin),
      description: pluginDescription(plugin, detail),
      version: plugin.localVersion ?? null,
      author: plugin.interface?.developerName ?? null,
      installState: plugin.installed ? 'installed' : 'not_installed',
      enabled: plugin.enabled,
      componentStates: skillStates,
      manifest: {
        name: plugin.name,
        id: plugin.id,
        source: plugin.source ?? null,
        installPolicy: plugin.installPolicy ?? null,
        authPolicy: plugin.authPolicy ?? null,
        availability: plugin.availability ?? null,
      },
      components,
      interface: plugin.interface ?? null,
      packageRef: null,
      sourcePayload: sourcePayload(marketplace, plugin),
    },
    status: { state: plugin.enabled ? 'enabled' : 'disabled' },
  }
}

function filteredMarketplaces(
  marketplaces: CodexPluginMarketplaceEntry[],
  marketplaceId?: string
): CodexPluginMarketplaceEntry[] {
  const normalized = marketplaceId?.trim()
  if (!normalized) return marketplaces
  return marketplaces.filter(marketplace => marketplace.name === normalized)
}

function filterPluginItems(
  items: PluginMarketplaceItem[],
  query?: string
): PluginMarketplaceItem[] {
  const normalizedQuery = query?.trim().toLowerCase()
  if (!normalizedQuery) return items
  return items.filter(item =>
    `${item.name} ${item.displayName} ${item.description}`.toLowerCase().includes(normalizedQuery)
  )
}

async function readPluginDetail(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary
): Promise<CodexPluginDetail | null> {
  try {
    const response = await codexAppServerRequest<{ plugin: CodexPluginDetail }>('plugin/read', {
      marketplacePath: marketplace.path ?? null,
      remoteMarketplaceName: marketplace.path ? null : marketplace.name,
      pluginName: plugin.name,
    })
    return response.plugin
  } catch (error) {
    console.warn('[Wework plugins] failed to read Codex plugin detail', {
      marketplace: marketplace.name,
      plugin: plugin.name,
      error,
    })
    return null
  }
}

async function readState(
  params: {
    query?: string
    marketplaceId?: string
    refresh?: boolean
  } = {}
): Promise<LocalCodexPluginsState> {
  if (!isTauriRuntime()) return emptyState
  const [availableResponse, installedResponse] = await Promise.all([
    codexAppServerRequest<{
      marketplaces: CodexPluginMarketplaceEntry[]
      featuredPluginIds?: string[]
    }>('plugin/list', {
      cwds: null,
      marketplaceKinds: [
        'local',
        'vertical',
        'workspace-directory',
        'shared-with-me',
        'created-by-me-remote',
      ],
    }),
    codexAppServerRequest<{ marketplaces: CodexPluginMarketplaceEntry[] }>('plugin/installed', {
      cwds: null,
      installSuggestionPluginNames: null,
    }),
  ])
  const requestedSelectedId =
    params.marketplaceId?.trim() ||
    selectedMarketplaceId() ||
    availableResponse.marketplaces[0]?.name ||
    ''
  const selectedId = availableResponse.marketplaces.some(
    marketplace => marketplace.name === requestedSelectedId
  )
    ? requestedSelectedId
    : (availableResponse.marketplaces[0]?.name ?? '')
  const selectedMarketplaces = filteredMarketplaces(availableResponse.marketplaces, selectedId)
  const marketplaceItems = filterPluginItems(
    selectedMarketplaces.flatMap(marketplace =>
      marketplace.plugins.map(plugin => toMarketplaceItem(marketplace, plugin))
    ),
    params.query
  )
  const installedDetails = await Promise.all(
    installedResponse.marketplaces.flatMap(marketplace =>
      marketplace.plugins.map(async plugin => ({
        marketplace,
        plugin,
        detail: await readPluginDetail(marketplace, plugin),
      }))
    )
  )
  const installedPlugins = installedDetails.map(({ marketplace, plugin, detail }) =>
    toInstalledPlugin(marketplace, plugin, detail)
  )
  const marketplaces = availableResponse.marketplaces.map(marketplaceInfo)
  const state: LocalCodexPluginsState = {
    marketplaceItems,
    installedPlugins,
    marketplaces,
    selectedMarketplaceId: selectedId,
    marketplacePath:
      availableResponse.marketplaces.find(marketplace => marketplace.name === selectedId)?.path ??
      selectedId,
    installRegistryPath: '',
  }
  cachedState = state
  rememberSelectedMarketplaceId(selectedId)
  return state
}

export function createLocalCodexPluginApi(): LocalCodexPluginApi {
  return {
    readState(params = {}) {
      return readState({
        query: params.q,
        marketplaceId: params.marketplaceId,
        refresh: params.refresh,
      })
    },
    async listInstalledPlugins() {
      const state = await readState()
      return { items: state.installedPlugins }
    },
    async listSkills(params = {}) {
      if (!isTauriRuntime()) return []
      const response = await codexAppServerRequest<{ data: CodexSkillsListEntry[] }>(
        'skills/list',
        {
          cwds: params.cwds ?? [],
          forceReload: params.forceReload ?? false,
        }
      )
      return response.data.flatMap(entry =>
        entry.skills.filter(skill => skill.enabled !== false).map(toLocalDeviceSkill)
      )
    },
    async listApps(params = {}) {
      if (!isTauriRuntime()) return []
      const apps: LocalDeviceApp[] = []
      let cursor: string | null = null
      do {
        const response: {
          data: CodexAppInfo[]
          nextCursor: string | null
        } = await codexAppServerRequest<{
          data: CodexAppInfo[]
          nextCursor: string | null
        }>('app/list', {
          cursor,
          limit: 100,
          forceRefetch: params.forceRefetch ?? false,
        })
        apps.push(...response.data.map(toLocalDeviceApp))
        cursor = response.nextCursor
      } while (cursor)
      return apps.filter(app => app.isEnabled !== false && app.isAccessible !== false)
    },
    async listAvailablePlugins(params = {}) {
      const state = await readState({
        query: params.q,
        marketplaceId: params.marketplaceId,
        refresh: params.refresh,
      })
      return { items: state.marketplaceItems }
    },
    selectMarketplace(id) {
      rememberSelectedMarketplaceId(id)
      return readState({ marketplaceId: id })
    },
    async deleteMarketplace(id) {
      await codexAppServerRequest('marketplace/remove', {
        marketplaceName: id,
      })
      if (selectedMarketplaceId() === id) rememberSelectedMarketplaceId('')
      return readState({ refresh: true })
    },
    async reorderMarketplaces() {
      return readState()
    },
    async upsertMarketplace(data) {
      const response = await codexAppServerRequest<{
        marketplaceName: string
        installedRoot: string
      }>('marketplace/add', {
        source: data.path,
        refName: null,
        sparsePaths: null,
      })
      rememberSelectedMarketplaceId(response.marketplaceName)
      return readState({ marketplaceId: response.marketplaceName, refresh: true })
    },
    async installAvailablePlugin(pluginId) {
      const currentState = cachedState ?? (await readState())
      const item = currentState.marketplaceItems.find(item => String(item.id) === String(pluginId))
      if (!item) throw new Error('Codex plugin not found in current marketplace')
      const marketplace = currentState.marketplaces.find(
        marketplace => marketplace.id === currentState.selectedMarketplaceId
      )
      if (!marketplace) throw new Error('Codex marketplace not selected')
      const localMarketplace = isLocalMarketplacePath(marketplace.path)
      await codexAppServerRequest('plugin/install', {
        marketplacePath: localMarketplace ? marketplace.path : null,
        remoteMarketplaceName: localMarketplace ? null : marketplace.id,
        pluginName: pluginInstallName(item, localMarketplace),
      })
      const state = await readState({
        marketplaceId: currentState.selectedMarketplaceId,
        refresh: true,
      })
      const installed = state.installedPlugins.find(
        plugin => String(installedPluginId(plugin)) === String(pluginId)
      )
      if (!installed) throw new Error('Codex plugin installed but not returned by app-server')
      return installed
    },
    async updateInstalledPlugin(id, data) {
      if (data.componentStates) {
        const currentState = cachedState ?? (await readState())
        const plugin = currentState.installedPlugins.find(
          plugin => String(installedPluginId(plugin)) === String(id)
        )
        await Promise.all(
          Object.entries(data.componentStates).map(([componentKey, enabled]) => {
            const skillName = componentKey.startsWith('skill:')
              ? componentKey.slice('skill:'.length)
              : componentKey
            const skill = plugin?.spec.components.skills.find(skill => skill.name === skillName)
            return codexAppServerRequest('skills/config/write', {
              path: skill?.path ?? null,
              name: skill?.path ? null : skillName,
              enabled,
            })
          })
        )
      }
      const state = await readState({ refresh: true })
      const installed = state.installedPlugins.find(
        plugin => String(installedPluginId(plugin)) === String(id)
      )
      if (!installed) throw new Error('Updated Codex plugin was not returned by app-server')
      return installed
    },
    async uninstallInstalledPlugin(id) {
      await codexAppServerRequest('plugin/uninstall', { pluginId: String(id) })
      cachedState = null
    },
  }
}
