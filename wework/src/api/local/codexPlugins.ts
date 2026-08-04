import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'
import {
  ensureBundledPluginMarketplaceRegistered,
  ensureLocalExecutorStarted,
  getInitializedBundledPluginMarketplace,
  requestLocalExecutor,
} from '@/tauri/localExecutor'
import type {
  InstalledPlugin,
  InstalledPluginComponents,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
  LocalDeviceApp,
  LocalDeviceSkill,
  PluginInterface,
  PluginCopyResponse,
  PluginMarketplaceItem,
  PluginMarketplaceListResponse,
} from '@/types/api'
import {
  isPersonalMarketplaceId,
  WEWORK_PERSONAL_MARKETPLACE_ID,
} from '@/features/plugins/builtinPlugins'
import {
  isBuiltInMarketplaceId,
  isInternalDeviceMarketplaceId,
  isOpenAiOfficialMarketplaceId,
} from '@/features/plugins/marketplaceIdentity'

export interface LocalCodexPluginsState {
  marketplaceItems: PluginMarketplaceItem[]
  installedPlugins: InstalledPlugin[]
  marketplaces: LocalCodexMarketplace[]
  selectedMarketplaceId: string
  marketplacePath: string
  installRegistryPath: string
  deviceId: string
}

export interface LocalCodexHomeMigrationStatus {
  weworkCodexHome: string
  nativeCodexHome: string
  weworkCodexHomeExists: boolean
  nativeCodexHomeExists: boolean
  shouldPromptMigration: boolean
}

export type ExternalContentSource = 'codex' | 'claude-code'

export interface ExternalContentImportResult {
  source: ExternalContentSource
  sourcePath: string
  destinationPath: string
  importedEntries: string[]
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

export interface LocalPluginCopyImportResult {
  pluginName: string
  displayName: string
  version: string
  marketplacePath: string
  pluginPath: string
}

export interface PluginIdentityReference {
  marketplaceName: string
  pluginName: string
}

function normalizeMarketplaceSource(source: string): string {
  const normalized = source.trim().replace(/\\\\/g, '/')
  return normalized.replace(/(?:\/\.agents\/plugins)?\/marketplace\.json$/i, '')
}

export interface LocalCodexPluginApi {
  importExternalContent(source: ExternalContentSource): Promise<ExternalContentImportResult>
  codexHomeMigrationStatus(): Promise<LocalCodexHomeMigrationStatus>
  initializeCodexHome(options: {
    migrateNativeHome: boolean
    remoteAppsEnabled?: boolean
  }): Promise<LocalCodexHomeMigrationStatus>
  migrateNativeCodexHome(remoteAppsEnabled?: boolean): Promise<LocalCodexHomeMigrationStatus>
  readCodexLocalConfig(): Promise<LocalCodexLocalConfig>
  updateCodexLocalConfig(patch: LocalCodexLocalConfigPatch): Promise<LocalCodexLocalConfig>
  packageCreatedPlugin(plugin: InstalledPlugin): Promise<File>
  linkPersonalPluginRelease(
    plugin: InstalledPlugin,
    cloudPluginId: number,
    cloudReleaseId: number
  ): Promise<void>
  importMarketplaceCopy(descriptor: PluginCopyResponse): Promise<InstalledPlugin>
  readState(params?: {
    q?: string
    marketplaceId?: string
    mergeAllMarketplaces?: boolean
    refresh?: boolean
  }): Promise<LocalCodexPluginsState>
  readMarketplacePluginDetail(marketplaceId: string, pluginName: string): Promise<InstalledPlugin>
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
  upsertMarketplace(data: { id?: string; path: string }): Promise<LocalCodexPluginsState>
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
  deviceId: '',
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
  agents?: Array<{
    name: string
    path?: string | null
    description?: string | null
  }>
  mcpServers?: string[]
  connectors?: Array<{
    slug: string
    authPolicy?: 'on_install' | 'on_use' | 'optional' | string | null
    localAuth?: {
      kind?: 'local_qr'
      health?: string[]
      start?: string[]
      poll?: string[]
      logout?: string[]
      qrField?: string
      statusField?: string
      okValues?: string[]
      pollIntervalSeconds?: number
    } | null
    description?: string | null
  }>
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
let cachedStateGeneration = 0
let nextReadStateGeneration = 1

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

export function pluginEnabledConfigKeyPath(id: string | number): string {
  return `plugins.${JSON.stringify(String(id))}.enabled`
}

function installedPluginConfigId(plugin: InstalledPlugin, fallbackId: string | number): string {
  const id = String(fallbackId)
  if (id.includes('@')) return id

  const payload = plugin.spec.sourcePayload
  const payloadRecord = payload && typeof payload === 'object' ? payload : {}
  const marketplace =
    (typeof payloadRecord.marketplaceName === 'string' && payloadRecord.marketplaceName.trim()) ||
    (typeof plugin.metadata.namespace === 'string' && plugin.metadata.namespace.trim()) ||
    plugin.spec.source.providerKey
  return `${plugin.spec.source.pluginKey}@${marketplace}`
}

function normalizedPluginIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function installedPluginMatchesReference(
  plugin: InstalledPlugin,
  reference: PluginIdentityReference
): boolean {
  if (plugin.spec.installState !== 'installed') return false
  const payload =
    plugin.spec.sourcePayload && typeof plugin.spec.sourcePayload === 'object'
      ? (plugin.spec.sourcePayload as Record<string, unknown>)
      : {}
  const pluginNames = [
    plugin.metadata.name,
    plugin.spec.source.pluginKey,
    plugin.spec.manifest.name,
    payload.pluginName,
  ]
  const marketplaceNames = [
    plugin.metadata.namespace,
    plugin.spec.source.providerKey,
    plugin.spec.source.marketplace,
    payload.marketplaceName,
  ]

  return (
    pluginNames.some(
      name => normalizedPluginIdentity(name) === normalizedPluginIdentity(reference.pluginName)
    ) &&
    marketplaceNames.some(
      name => normalizedPluginIdentity(name) === normalizedPluginIdentity(reference.marketplaceName)
    )
  )
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

function catalogItemId(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary
): string {
  // Keep built-in / personal ids stable for cloud merge and install lookups. Namespace
  // user-added marketplace rows so they never collide with cloud numeric plugin ids.
  if (isBuiltInMarketplaceId(marketplace.name) || isPersonalMarketplaceId(marketplace.name)) {
    return String(plugin.id)
  }
  return `${marketplace.name}:${plugin.id}`
}

function localMarketplaceSource(marketplace: CodexPluginMarketplaceEntry): {
  sourceProvider: 'wegent' | 'codex' | 'user'
  sourceLabel: string
  visibility: 'personal' | 'workspace' | 'public'
} {
  if (isPersonalMarketplaceId(marketplace.name)) {
    return { sourceProvider: 'user', sourceLabel: '个人分享', visibility: 'personal' }
  }
  if (isInternalDeviceMarketplaceId(marketplace.name)) {
    return { sourceProvider: 'wegent', sourceLabel: 'Wegent 官方', visibility: 'workspace' }
  }
  if (isOpenAiOfficialMarketplaceId(marketplace.name)) {
    return { sourceProvider: 'codex', sourceLabel: 'OpenAI 官方', visibility: 'public' }
  }
  return {
    sourceProvider: 'codex',
    sourceLabel: marketplace.interface?.displayName?.trim() || marketplace.name,
    visibility: 'public',
  }
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
  components.connectors = (detail.connectors ?? []).map(connector => {
    const localAuth = connector.localAuth
    return {
      slug: connector.slug,
      authPolicy:
        connector.authPolicy === 'on_install' ||
        connector.authPolicy === 'on_use' ||
        connector.authPolicy === 'optional'
          ? connector.authPolicy
          : 'optional',
      localAuth:
        localAuth?.health && localAuth.start && localAuth.poll
          ? {
              ...localAuth,
              health: localAuth.health,
              start: localAuth.start,
              poll: localAuth.poll,
            }
          : null,
    }
  })
  components.agents = (detail.agents ?? []).map(agent => ({
    name: agent.name,
    path: agent.path ?? agent.name,
    description: agent.description ?? null,
  }))
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
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): PluginMarketplaceItem {
  const components = pluginComponents(detail)
  const source = localMarketplaceSource(marketplace)
  return {
    id: catalogItemId(marketplace, plugin),
    remotePluginId: plugin.remotePluginId ?? plugin.id,
    name: plugin.name,
    displayName: pluginDisplayName(plugin),
    description: pluginDescription(plugin, detail),
    version: plugin.localVersion ?? null,
    author: plugin.interface?.developerName ?? null,
    visibility: source.visibility,
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
      marketplaceId: marketplace.name,
      source: plugin.source ?? null,
      installPolicy: plugin.installPolicy ?? null,
      authPolicy: plugin.authPolicy ?? null,
      availability: plugin.availability ?? null,
    },
    ownerUserId: 0,
    sourceProvider: source.sourceProvider,
    sourceLabel: source.sourceLabel,
  }
}

function toInstalledPlugin(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): InstalledPlugin {
  const components = pluginComponents(detail)
  const isCreated = isPersonalMarketplaceId(marketplace.name)
  const source = localMarketplaceSource(marketplace)
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
        type: isCreated ? 'local' : 'marketplace',
        providerKey: marketplace.name,
        pluginKey: plugin.name,
        catalogItemId: plugin.remotePluginId ?? plugin.id,
        marketplace: marketplace.name,
      },
      origin: isCreated ? 'created' : 'market',
      sourceProvider: source.sourceProvider,
      sourceLabel: source.sourceLabel,
      visibility: source.visibility,
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
      sourcePayload: {
        ...sourcePayload(marketplace, plugin),
        localId: isCreated ? plugin.id : null,
      },
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

function withInitializedBundledMarketplace(
  marketplaces: CodexPluginMarketplaceEntry[]
): CodexPluginMarketplaceEntry[] {
  const bundled = getInitializedBundledPluginMarketplace()
  if (!bundled || marketplaces.some(marketplace => marketplace.name === bundled.id)) {
    return marketplaces
  }
  return [
    ...marketplaces,
    {
      name: bundled.id,
      path: bundled.path,
      interface: { displayName: bundled.id },
      plugins: [],
    },
  ]
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
    mergeAllMarketplaces?: boolean
    refresh?: boolean
  } = {}
): Promise<LocalCodexPluginsState> {
  if (!isTauriRuntime()) return emptyState
  const generation = nextReadStateGeneration++
  const executorStatus = await ensureLocalExecutorStarted()
  await ensureBundledPluginMarketplaceRegistered()
  const requestedMarketplaceId = params.mergeAllMarketplaces
    ? ''
    : params.marketplaceId?.trim() || selectedMarketplaceId()
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
  const availableMarketplaces = withInitializedBundledMarketplace(availableResponse.marketplaces)
  const requestedSelectedId = requestedMarketplaceId || availableMarketplaces[0]?.name || ''
  const selectedId = availableMarketplaces.some(
    marketplace => marketplace.name === requestedSelectedId
  )
    ? requestedSelectedId
    : (availableMarketplaces[0]?.name ?? '')
  const selectedMarketplaces = params.mergeAllMarketplaces
    ? availableMarketplaces
    : filteredMarketplaces(availableMarketplaces, selectedId)
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
    deviceId: executorStatus.deviceId?.trim() ?? '',
  }
  if (generation >= cachedStateGeneration) {
    cachedState = state
    cachedStateGeneration = generation
    rememberSelectedMarketplaceId(selectedId)
  }
  return state
}

export function createLocalCodexPluginApi(): LocalCodexPluginApi {
  const defaultCodexLocalConfig: LocalCodexLocalConfig = {
    codexHome: '',
    configPath: '',
    remoteAppsEnabled: true,
  }
  return {
    importExternalContent(source) {
      if (!isTauriRuntime()) {
        return Promise.reject(new Error('External content import requires the Wework desktop app'))
      }
      return invoke<ExternalContentImportResult>('local_executor_import_external_content', {
        options: { source },
      })
    },
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
        options: {
          ...options,
          remoteAppsEnabled: options.remoteAppsEnabled ?? true,
        },
      })
    },
    migrateNativeCodexHome(remoteAppsEnabled = true) {
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
    async packageCreatedPlugin(plugin) {
      if (!isTauriRuntime()) {
        throw new Error('Packaging a local plugin requires the Wework desktop app')
      }
      const sourcePayload = plugin.spec.sourcePayload ?? {}
      const marketplacePath = sourcePayload.marketplacePath
      const pluginName = sourcePayload.pluginName
      if (typeof marketplacePath !== 'string' || !marketplacePath.trim()) {
        throw new Error('Local plugin marketplace path is unavailable')
      }
      if (typeof pluginName !== 'string' || !pluginName.trim()) {
        throw new Error('Local plugin name is unavailable')
      }
      const packaged = await invoke<{ name: string; bytes: number[] }>(
        'local_executor_package_plugin',
        { marketplacePath, pluginName }
      )
      return new File([new Uint8Array(packaged.bytes)], packaged.name, {
        type: 'application/zip',
      })
    },
    async linkPersonalPluginRelease(plugin, cloudPluginId, cloudReleaseId) {
      if (!isTauriRuntime()) return
      const sourcePayload = plugin.spec.sourcePayload ?? {}
      const marketplacePath = sourcePayload.marketplacePath
      const localPluginName = sourcePayload.pluginName
      if (typeof marketplacePath !== 'string' || typeof localPluginName !== 'string') {
        throw new Error('Local plugin source mapping is unavailable')
      }
      await invoke('local_executor_link_plugin_release', {
        marketplacePath,
        localPluginName,
        cloudPluginId,
        cloudReleaseId,
      })
    },
    async importMarketplaceCopy(descriptor) {
      if (!isTauriRuntime()) {
        throw new Error('Importing a plugin copy requires the Wework desktop app')
      }
      const currentState = cachedState ?? (await readState())
      const personalMarketplace = currentState.marketplaces.find(
        marketplace => marketplace.id === WEWORK_PERSONAL_MARKETPLACE_ID
      )
      if (!personalMarketplace || !isLocalMarketplacePath(personalMarketplace.path)) {
        throw new Error(`The ${WEWORK_PERSONAL_MARKETPLACE_ID} marketplace is unavailable`)
      }
      const imported = await invoke<LocalPluginCopyImportResult>(
        'local_executor_import_plugin_copy',
        {
          options: {
            marketplacePath: personalMarketplace.path,
            ...descriptor,
          },
        }
      )
      try {
        await codexAppServerRequest('plugin/install', {
          marketplacePath: personalMarketplace.path,
          remoteMarketplaceName: null,
          pluginName: imported.pluginName,
        })
      } catch (error) {
        await invoke('local_executor_rollback_plugin_copy', {
          marketplacePath: personalMarketplace.path,
          pluginName: imported.pluginName,
        }).catch(() => undefined)
        throw new Error(
          `Plugin copy installation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      }
      const nextState = await readState({ marketplaceId: personalMarketplace.id, refresh: true })
      const installed = nextState.installedPlugins.find(
        plugin =>
          plugin.metadata.namespace === personalMarketplace.id &&
          plugin.spec.source.pluginKey === imported.pluginName
      )
      if (!installed) {
        throw new Error('Plugin copy installed but was not returned by App Server')
      }
      return installed
    },
    readState(params = {}) {
      return readState({
        query: params.q,
        marketplaceId: params.marketplaceId,
        mergeAllMarketplaces: params.mergeAllMarketplaces,
        refresh: params.refresh,
      })
    },
    async readMarketplacePluginDetail(marketplaceId, pluginName) {
      if (!isTauriRuntime()) {
        throw new Error('Reading local plugin detail requires the Wework desktop app')
      }
      const normalizedMarketplaceId = marketplaceId.trim()
      const normalizedPluginName = pluginName.trim()
      if (!normalizedMarketplaceId || !normalizedPluginName) {
        throw new Error('Marketplace id and plugin name are required')
      }
      const state = cachedState ?? (await readState({ mergeAllMarketplaces: true }))
      const marketplaceMeta = state.marketplaces.find(entry => entry.id === normalizedMarketplaceId)
      if (!marketplaceMeta) {
        throw new Error(`Codex marketplace "${normalizedMarketplaceId}" is unavailable`)
      }
      const detail = await readPluginDetail(marketplaceMeta, normalizedPluginName)
      return toInstalledPlugin(
        {
          name: marketplaceMeta.id,
          path: marketplaceMeta.path,
          interface: { displayName: marketplaceMeta.name },
          plugins: [],
        },
        detail.summary,
        detail
      )
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
      const findInstalled = (state: LocalCodexPluginsState) =>
        state.installedPlugins.find(plugin => String(installedPluginId(plugin)) === String(id))

      let currentState = cachedState ?? (await readState())
      let installed = findInstalled(currentState)
      if (!installed) {
        currentState = await readState({ refresh: true })
        installed = findInstalled(currentState)
      }
      if (!installed) throw new Error('Codex plugin is not installed')
      const sourcePayload = installed.spec.sourcePayload
      const payload =
        sourcePayload && typeof sourcePayload === 'object'
          ? (sourcePayload as Record<string, unknown>)
          : null
      const marketplaceId =
        typeof payload?.marketplaceName === 'string'
          ? payload.marketplaceName
          : typeof installed.metadata.namespace === 'string'
            ? installed.metadata.namespace
            : installed.spec.source.marketplace || installed.spec.source.providerKey
      const pluginName =
        typeof payload?.pluginName === 'string'
          ? payload.pluginName
          : installed.spec.source.pluginKey
      const marketplace = currentState.marketplaces.find(
        marketplace => marketplace.id === marketplaceId
      ) ?? {
        id: marketplaceId,
        name: marketplaceId,
        path: marketplaceId,
      }
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
      const source = normalizeMarketplaceSource(data.path)
      if (data.id && data.id !== '') {
        const currentState = cachedState ?? (await readState())
        const existing = currentState.marketplaces.find(marketplace => marketplace.id === data.id)
        if (existing?.path === source) return currentState

        await codexAppServerRequest('marketplace/remove', {
          marketplaceName: data.id,
        })
      }
      const response = await codexAppServerRequest<{
        marketplaceName: string
        installedRoot: string
      }>('marketplace/add', {
        source,
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
      const installed = state.installedPlugins.find(plugin => {
        if (String(installedPluginId(plugin)) === String(pluginId)) return true
        const marketplaceName =
          typeof plugin.spec.sourcePayload?.marketplaceName === 'string'
            ? plugin.spec.sourcePayload.marketplaceName
            : typeof plugin.metadata.namespace === 'string'
              ? plugin.metadata.namespace
              : plugin.spec.source.marketplace || plugin.spec.source.providerKey
        return (
          plugin.spec.source.pluginKey === item.name &&
          marketplaceName === (item.manifest?.marketplaceId || marketplace.id)
        )
      })
      if (!installed) throw new Error('Codex plugin installed but not returned by app-server')
      return installed
    },
    async updateInstalledPlugin(id, data) {
      const currentState = cachedState ?? (await readState())
      const plugin = currentState.installedPlugins.find(
        plugin => String(installedPluginId(plugin)) === String(id)
      )
      if (!plugin) throw new Error('Codex plugin is not installed')
      if (data.enabled !== undefined) {
        await codexAppServerRequest('config/value/write', {
          keyPath: pluginEnabledConfigKeyPath(installedPluginConfigId(plugin, id)),
          value: data.enabled,
          mergeStrategy: 'upsert',
        })
      }
      if (data.componentStates) {
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
      cachedStateGeneration = 0
    },
  }
}
