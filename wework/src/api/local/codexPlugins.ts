import { invoke } from '@tauri-apps/api/core'
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

export interface LocalCodexHomeMigrationStatus {
  weworkCodexHome: string
  nativeCodexHome: string
  weworkCodexHomeExists: boolean
  nativeCodexHomeExists: boolean
  shouldPromptMigration: boolean
}

export interface LocalCodexLocalConfig {
  codexHome: string
  configPath: string
  remoteAppsEnabled: boolean
}

export interface LocalCodexLocalConfigPatch {
  remoteAppsEnabled?: boolean
}

export interface LocalCodexMarketplace {
  id: string
  name: string
  path: string
}

export interface LocalCodexPluginApi {
  codexHomeMigrationStatus(): Promise<LocalCodexHomeMigrationStatus>
  initializeCodexHome(options: {
    migrateNativeHome: boolean
    remoteAppsEnabled: boolean
  }): Promise<LocalCodexHomeMigrationStatus>
  migrateNativeCodexHome(remoteAppsEnabled?: boolean): Promise<LocalCodexHomeMigrationStatus>
  readCodexLocalConfig(): Promise<LocalCodexLocalConfig>
  updateCodexLocalConfig(patch: LocalCodexLocalConfigPatch): Promise<LocalCodexLocalConfig>
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
  readInstalledPluginForTrial(id: string | number): Promise<InstalledPlugin>
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
  appTemplates?: Array<{
    templateId: string
    name: string
    description?: string | null
    category?: string | null
    canonicalConnectorId?: string | null
    logoUrl?: string | null
    logoUrlDark?: string | null
    materializedAppIds?: string[]
    reason?: string | null
  }>
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
      description: template.description ?? null,
      category: template.category ?? null,
      canonicalConnectorId: template.canonicalConnectorId ?? null,
      logoUrl: template.logoUrl ?? null,
      logoUrlDark: template.logoUrlDark ?? null,
      materializedAppIds: template.materializedAppIds ?? [],
      unavailableReason: template.reason ?? null,
    })),
  ]
  components.templates = components.commands
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

async function readPluginDetail(
  marketplace: LocalCodexMarketplace,
  pluginName: string
): Promise<CodexPluginDetail> {
  const localMarketplace = isLocalMarketplacePath(marketplace.path)
  const response = await codexAppServerRequest<{ plugin: CodexPluginDetail }>('plugin/read', {
    marketplacePath: localMarketplace ? marketplace.path : null,
    remoteMarketplaceName: localMarketplace ? null : marketplace.id,
    pluginName,
  })
  return response.plugin
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

async function readState(
  params: {
    query?: string
    marketplaceId?: string
    refresh?: boolean
  } = {}
): Promise<LocalCodexPluginsState> {
  if (!isTauriRuntime()) return emptyState
  const requestedMarketplaceId = params.marketplaceId?.trim() || selectedMarketplaceId()
  const [availableResponse, installedResponse] = await Promise.all([
    codexAppServerRequest<{
      marketplaces: CodexPluginMarketplaceEntry[]
      featuredPluginIds?: string[]
    }>('plugin/list', {
      cwds: null,
    }),
    codexAppServerRequest<{ marketplaces: CodexPluginMarketplaceEntry[] }>('plugin/installed', {
      cwds: null,
      installSuggestionPluginNames: null,
    }),
  ])
  const availableMarketplaces = availableResponse.marketplaces
  const requestedSelectedId = requestedMarketplaceId || availableMarketplaces[0]?.name || ''
  const selectedId = availableMarketplaces.some(
    marketplace => marketplace.name === requestedSelectedId
  )
    ? requestedSelectedId
    : (availableMarketplaces[0]?.name ?? '')
  const selectedMarketplaces = filteredMarketplaces(availableMarketplaces, selectedId)
  const marketplaceItems = filterPluginItems(
    selectedMarketplaces.flatMap(marketplace =>
      marketplace.plugins.map(plugin => toMarketplaceItem(marketplace, plugin))
    ),
    params.query
  )
  const installedPlugins = installedResponse.marketplaces.flatMap(marketplace =>
    marketplace.plugins.map(plugin => toInstalledPlugin(marketplace, plugin))
  )
  const marketplaces = availableMarketplaces.map(marketplaceInfo)
  const state: LocalCodexPluginsState = {
    marketplaceItems,
    installedPlugins,
    marketplaces,
    selectedMarketplaceId: selectedId,
    marketplacePath:
      availableMarketplaces.find(marketplace => marketplace.name === selectedId)?.path ??
      selectedId,
    installRegistryPath: '',
  }
  cachedState = state
  rememberSelectedMarketplaceId(selectedId)
  return state
}

export function createLocalCodexPluginApi(): LocalCodexPluginApi {
  const defaultCodexLocalConfig: LocalCodexLocalConfig = {
    codexHome: '',
    configPath: '',
    remoteAppsEnabled: false,
  }
  return {
    codexHomeMigrationStatus() {
      if (!isTauriRuntime()) {
        return Promise.resolve({
          weworkCodexHome: '',
          nativeCodexHome: '',
          weworkCodexHomeExists: true,
          nativeCodexHomeExists: false,
          shouldPromptMigration: false,
        })
      }
      return invoke<LocalCodexHomeMigrationStatus>('local_executor_codex_home_migration_status')
    },
    initializeCodexHome(options) {
      if (!isTauriRuntime()) {
        return Promise.resolve({
          weworkCodexHome: '',
          nativeCodexHome: '',
          weworkCodexHomeExists: true,
          nativeCodexHomeExists: false,
          shouldPromptMigration: false,
        })
      }
      return invoke<LocalCodexHomeMigrationStatus>('local_executor_initialize_codex_home', {
        options,
      })
    },
    migrateNativeCodexHome(remoteAppsEnabled = false) {
      return this.initializeCodexHome({
        migrateNativeHome: true,
        remoteAppsEnabled,
      })
    },
    readCodexLocalConfig() {
      if (!isTauriRuntime()) {
        return Promise.resolve(defaultCodexLocalConfig)
      }
      return invoke<LocalCodexLocalConfig>('local_executor_read_codex_local_config')
    },
    updateCodexLocalConfig(patch) {
      if (!isTauriRuntime()) {
        return Promise.resolve({ ...defaultCodexLocalConfig, ...patch })
      }
      return invoke<LocalCodexLocalConfig>('local_executor_update_codex_local_config', { patch })
    },
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
    async readInstalledPluginForTrial(id) {
      const currentState = cachedState ?? (await readState())
      const installed = currentState.installedPlugins.find(
        plugin => String(installedPluginId(plugin)) === String(id)
      )
      if (!installed) throw new Error('Codex plugin is not installed')
      const sourcePayload = installed.spec.sourcePayload
      const payload =
        sourcePayload && typeof sourcePayload === 'object'
          ? (sourcePayload as Record<string, unknown>)
          : null
      const marketplaceId =
        typeof payload?.marketplaceName === 'string'
          ? payload.marketplaceName
          : installed.metadata.namespace
      const pluginName =
        typeof payload?.pluginName === 'string'
          ? payload.pluginName
          : installed.spec.source.pluginKey
      const marketplace = currentState.marketplaces.find(
        marketplace => marketplace.id === marketplaceId
      )
      if (!marketplace) throw new Error('Codex marketplace not found for installed plugin')
      const summary = currentState.marketplaceItems.find(
        item => String(item.installedPluginId ?? item.id) === String(id)
      )
      const detail = await readPluginDetail(marketplace, pluginName)
      return toInstalledPlugin(
        {
          name: marketplace.id,
          path: marketplace.path,
          interface: {
            displayName: marketplace.name,
          },
          plugins: [],
        },
        {
          id: String(id),
          remotePluginId:
            typeof payload?.remotePluginId === 'string'
              ? payload.remotePluginId
              : (summary?.remotePluginId ?? String(id)),
          localVersion: installed.spec.version ?? summary?.version ?? null,
          name: pluginName,
          source:
            installed.spec.manifest && typeof installed.spec.manifest === 'object'
              ? (installed.spec.manifest.source as Record<string, unknown> | undefined)
              : undefined,
          installed: true,
          enabled: installed.spec.enabled,
          installPolicy:
            typeof installed.spec.manifest?.installPolicy === 'string'
              ? installed.spec.manifest.installPolicy
              : undefined,
          authPolicy:
            typeof installed.spec.manifest?.authPolicy === 'string'
              ? installed.spec.manifest.authPolicy
              : undefined,
          availability:
            typeof installed.spec.manifest?.availability === 'string'
              ? installed.spec.manifest.availability
              : undefined,
          interface: installed.spec.interface ?? summary?.interface ?? null,
          keywords: [],
        },
        detail
      )
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
