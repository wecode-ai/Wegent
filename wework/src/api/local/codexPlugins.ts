import i18n from '@/i18n'
import { sha256Hex } from '@/api/fileHash'
import { getErrorMessage } from '@/lib/error-message'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { LocalPluginUninstallCleanupError } from './pluginUninstallError'
import {
  ensureBundledPluginMarketplaceRegistered,
  ensureLocalExecutorStarted,
  getInitializedBundledPluginMarketplace,
  requestLocalExecutor,
} from '@/desktop/localExecutor'
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
  CODEX_PERSONAL_MARKETPLACE_ID,
  isPersonalMarketplaceId,
  WEWORK_PERSONAL_MARKETPLACE_ID,
} from '@/features/plugins/builtinPlugins'
import {
  INTERNAL_DEVICE_MARKETPLACE_ID,
  isBuiltInMarketplaceId,
  isInternalDeviceMarketplaceId,
  isOpenAiOfficialMarketplaceId,
  isOpenAiOfficialRemoteMarketplaceId,
} from '@/features/plugins/marketplaceIdentity'
import { rankMarketplaceSearchResults } from '@/features/plugins/marketplaceSearch'
import { preferWeworkPersonalInstalled } from '@/features/plugins/personalPluginMigration'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'
import { slimPluginComponentsForCache } from '@/features/plugins/slimPluginComponents'
import { mergeLocalInstalledWithStorePackages } from '@/components/plugins/installedPluginMerge'

const MAX_PERSONAL_PLUGIN_PACKAGE_BYTES = 50 * 1024 * 1024

interface LocalPluginPackageArtifact {
  name: string
  path: string
  size: number
  sha256: string
  cleanupToken: string
}

function validateLocalPluginPackageArtifact(
  value: LocalPluginPackageArtifact
): LocalPluginPackageArtifact {
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.path !== 'string' ||
    !value.path.trim() ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_PERSONAL_PLUGIN_PACKAGE_BYTES ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.cleanupToken !== 'string' ||
    !value.cleanupToken.trim()
  ) {
    throw new Error('Executor returned invalid personal plugin package metadata')
  }
  return value
}

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

export interface LocalPluginImportIssue {
  code: string
  path: string | null
  message: string
}

export interface LocalPluginImportPreview {
  valid: boolean
  archivePath: string
  sha256: string
  name: string
  displayName: string
  version: string
  description: string
  skillCount: number
  mcpServerCount: number
  executableCapabilities: string[]
  existing: boolean
  existingVersion: string | null
  issues: LocalPluginImportIssue[]
}

interface LocalPluginPackageImportResult {
  pluginName: string
  displayName: string
  version: string
  marketplacePath: string
  pluginPath: string
  rollbackId: string
}

export interface LocalPluginImportCompletion {
  pluginName: string
  displayName: string
  version: string
}

interface LocalPluginInstallCommitResult {
  pluginKey: string
  localCommitted: boolean
}

export interface LocalPluginCloudLink {
  localPluginName: string
  cloudPluginId: number
  cloudReleaseId: number | null
}

async function readLocalPluginCloudLinks(marketplacePath: string): Promise<LocalPluginCloudLink[]> {
  return requestLocalExecutor<LocalPluginCloudLink[]>('executor.plugins.links.list', {
    marketplacePath,
  })
}

async function unlinkLocalPluginRelease(
  marketplacePath: string,
  localPluginName: string
): Promise<void> {
  await requestLocalExecutor('executor.plugins.links.unlink', {
    marketplacePath,
    localPluginName,
  })
}

export interface PluginIdentityReference {
  marketplaceName: string
  pluginName: string
}

export function normalizeMarketplaceSource(source: string): string {
  const normalized = source.trim().replace(/\\\\/g, '/')
  return normalized.replace(/(?:\/\.agents\/plugins)?\/marketplace\.json$/i, '')
}

export function codexMarketplaceManifestSource(source: string): string {
  return `${normalizeMarketplaceSource(source).replace(/\/+$/, '')}/.agents/plugins/marketplace.json`
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
  ensureCreatedPluginInWeworkPersonal(plugin: InstalledPlugin): Promise<{
    pluginName: string
    marketplacePath: string
    pluginPath: string
    migrated: boolean
  }>
  linkPersonalPluginRelease(
    plugin: InstalledPlugin,
    cloudPluginId: number,
    cloudReleaseId: number | null
  ): Promise<void>
  importMarketplaceCopy(descriptor: PluginCopyResponse): Promise<InstalledPlugin>
  previewPluginImport(archivePath: string): Promise<LocalPluginImportPreview>
  importPluginPackage(
    preview: LocalPluginImportPreview,
    overwrite: boolean
  ): Promise<LocalPluginImportCompletion>
  savePluginExample(destinationPath: string): Promise<string>
  deletePersonalPlugin(pluginName: string, marketplacePath?: string): Promise<void>
  readState(params?: {
    q?: string
    marketplaceId?: string
    mergeAllMarketplaces?: boolean
    refresh?: boolean
  }): Promise<LocalCodexPluginsState>
  readMarketplacePluginDetail(marketplaceId: string, pluginName: string): Promise<InstalledPlugin>
  listInstalledPlugins(options?: {
    refresh?: boolean
    /** Start a new membership read when a newer refresh supersedes a pending one. */
    shareInflight?: boolean
  }): Promise<InstalledPluginListResponse & { deviceId?: string }>
  listSkills(params?: { cwds?: string[]; forceReload?: boolean }): Promise<LocalDeviceSkill[]>
  listApps(params?: {
    forceRefetch?: boolean
    includeInaccessible?: boolean
  }): Promise<LocalDeviceApp[]>
  listAvailablePlugins(params?: {
    q?: string
    marketplaceId?: string
    refresh?: boolean
  }): Promise<PluginMarketplaceListResponse>
  selectMarketplace(id: string): Promise<LocalCodexPluginsState>
  /** Persist the active marketplace without reconciling plugin/list. */
  rememberMarketplaceSelection(id: string): void
  readInstalledPluginForTrial(id: string | number): Promise<InstalledPlugin>
  /**
   * Enrich one installed summary via `plugin/read` only. Never calls `plugin/list`
   * / full `readState` — safe for composer send preflight.
   */
  readInstalledPluginDetail(plugin: InstalledPlugin): Promise<InstalledPlugin>
  deleteMarketplace(id: string): Promise<LocalCodexPluginsState>
  reorderMarketplaces(ids: string[]): Promise<LocalCodexPluginsState>
  upsertMarketplace(data: { id?: string; path: string }): Promise<LocalCodexPluginsState>
  installAvailablePlugin(
    pluginId: string | number,
    marketplaceId?: string
  ): Promise<InstalledPlugin>
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
  /** Codex PluginAvailability: AVAILABLE | DISABLED_BY_ADMIN */
  availability?: string
  /** Remote catalog reason, e.g. plan_not_eligible */
  disabledReason?: string | null
  eligiblePlanTypes?: string[] | null
  interface?: PluginInterface | null
  keywords?: string[]
}

interface CodexPluginConnector {
  slug: string
  authPolicy?: 'on_install' | 'on_use' | 'optional' | string | null
  localAuth?: {
    kind?: 'local_qr' | 'browser_oauth'
    health?: string[]
    start?: string[]
    poll?: string[]
    logout?: string[]
    tool?: {
      id: string
      source: 'bundled' | 'managed'
      version?: string | null
      artifacts?: Record<
        string,
        {
          url: string
          sha256: string
          archive: 'tar_gz' | 'zip'
          binaryPath: string
        }
      >
    } | null
    qrField?: string
    statusField?: string
    okValues?: string[]
    pollIntervalSeconds?: number
    timeoutSeconds?: number
    logoutOnUninstall?: boolean
  } | null
  description?: string | null
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
  apps?: Array<{
    id: string
    name: string
    slug?: string | null
    required?: boolean | null
    description?: string | null
  }>
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
  connectors?: CodexPluginConnector[]
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
/**
 * Durable across app restarts so OpenAI/local tabs can paint before plugin/list (~10s).
 * v2 keeps installed connector/localAuth stubs so composer send preflight can skip
 * plugin/read after a cache hit (v1 stripped all components and forced a cold detail).
 */
const READ_STATE_LOCAL_STORAGE_KEY = 'wework.plugins.codexReadState.v2'
/** Same-session fallback for the current durable key. */
const READ_STATE_SESSION_STORAGE_KEY = 'wework.plugins.codexReadState.v2'
/** Previous durable keys — read once for migration, then remove. */
const READ_STATE_LEGACY_STORAGE_KEYS = ['wework.plugins.codexReadState.v1'] as const
/** Serve memory/local cache without hitting Codex while fresher than this. */
const READ_STATE_FRESH_TTL_MS = 60_000
/** Keep a durable snapshot so cold app launches can paint before plugin/list (~10s). */
const READ_STATE_DURABLE_TTL_MS = 7 * 24 * 60 * 60_000
/** Keep package artwork from exhausting the shared WebView localStorage quota. */
const MAX_DURABLE_DATA_URL_CHARS = 4096
/** A marketplace switch can produce several equivalent snapshots; bound their disk footprint. */
const MAX_DURABLE_READ_STATE_ENTRIES = 4
let cachedState: LocalCodexPluginsState | null = null
let cachedStateGeneration = 0
let nextReadStateGeneration = 1
let cachedStateAt = 0
let cachedStateParamsKey = ''
const inflightReadState = new Map<string, Promise<LocalCodexPluginsState>>()
let inflightPluginInstalled: Promise<{
  marketplaces: CodexPluginMarketplaceEntry[]
}> | null = null
let inflightWegentStoreList: Promise<InstalledPlugin[]> | null = null
let didHydrateReadStateSession = false
let warmupReadStatePromise: Promise<LocalCodexPluginsState> | null = null

type PersistedReadStateEntry = {
  paramsKey: string
  cachedAt: number
  state: LocalCodexPluginsState
}

type PersistedReadStateStore = {
  version: 2
  entries: Record<string, PersistedReadStateEntry>
}

/** Clears the short-lived readState cache. Intended for tests and explicit invalidation. */
export function clearLocalCodexPluginsReadStateCache(): void {
  cachedState = null
  cachedStateGeneration = 0
  cachedStateAt = 0
  cachedStateParamsKey = ''
  inflightReadState.clear()
  inflightPluginInstalled = null
  inflightWegentStoreList = null
  didHydrateReadStateSession = false
  warmupReadStatePromise = null
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(READ_STATE_LOCAL_STORAGE_KEY)
    window.sessionStorage.removeItem(READ_STATE_SESSION_STORAGE_KEY)
    for (const legacyKey of READ_STATE_LEGACY_STORAGE_KEYS) {
      window.localStorage.removeItem(legacyKey)
      window.sessionStorage.removeItem(legacyKey)
    }
  }
}

function readStateParamsKey(params: {
  marketplaceId?: string
  mergeAllMarketplaces?: boolean
}): string {
  // Search query is applied in-memory after load; keep it out of the cache key so
  // typing/clearing search reuses the same plugin/list + plugin/installed snapshot.
  return [
    params.marketplaceId?.trim() || '',
    params.mergeAllMarketplaces ? 'all' : 'selected',
  ].join('|')
}

function parsePersistedReadStateStore(raw: string | null): PersistedReadStateStore | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      version?: number
      entries?: Record<string, PersistedReadStateEntry>
    }
    if (
      (parsed?.version !== 1 && parsed?.version !== 2) ||
      !parsed.entries ||
      typeof parsed.entries !== 'object'
    ) {
      return null
    }
    // Accept v1 snapshots written before connector stubs were kept in durable cache.
    return { version: 2, entries: parsed.entries }
  } catch {
    return null
  }
}

function preferredPersistedReadStateEntry(
  store: PersistedReadStateStore
): PersistedReadStateEntry | undefined {
  // PluginsWorkspace always peeks the merged catalog for first paint. Preserve
  // that canonical entry ahead of a newer single-market snapshot under quota.
  return (
    store.entries[readStateParamsKey({ mergeAllMarketplaces: true })] ??
    Object.values(store.entries).sort((left, right) => right.cachedAt - left.cachedAt)[0]
  )
}

function readPersistedReadStateStore(): PersistedReadStateStore {
  if (typeof window === 'undefined') return { version: 2, entries: {} }
  const localRaw = window.localStorage.getItem(READ_STATE_LOCAL_STORAGE_KEY)
  const fromLocal = parsePersistedReadStateStore(localRaw)
  if (fromLocal) {
    const compacted: PersistedReadStateStore = {
      version: 2,
      entries: Object.fromEntries(
        Object.entries(fromLocal.entries).map(([key, entry]) => [
          key,
          { ...entry, state: toDurableReadState(entry.state) },
        ])
      ),
    }
    const compactedRaw = JSON.stringify(compacted)
    if (localRaw && compactedRaw.length < localRaw.length) {
      // Early v2 builds stored complete plugin details. Compact them before any
      // network refresh so an old snapshot cannot keep the shared quota full.
      try {
        window.localStorage.setItem(READ_STATE_LOCAL_STORAGE_KEY, compactedRaw)
      } catch {
        // The compact in-memory value is still usable for this session.
      }
    }
    return compacted
  }

  // Migrate yesterday's v1 durable peek / session snapshot into v2 once.
  for (const legacyKey of READ_STATE_LEGACY_STORAGE_KEYS) {
    const migrated = parsePersistedReadStateStore(window.localStorage.getItem(legacyKey))
    if (migrated) {
      writePersistedReadStateStore(migrated)
      try {
        window.localStorage.removeItem(legacyKey)
        window.sessionStorage.removeItem(legacyKey)
      } catch {
        // Ignore storage failures; memory cache still works for the session.
      }
      return migrated
    }
    const migratedSession = parsePersistedReadStateStore(window.sessionStorage.getItem(legacyKey))
    if (migratedSession) {
      writePersistedReadStateStore(migratedSession)
      try {
        window.sessionStorage.removeItem(legacyKey)
      } catch {
        // Ignore storage failures; memory cache still works for the session.
      }
      return migratedSession
    }
  }

  // One-time migration from the previous same-session snapshot.
  const fromSession = parsePersistedReadStateStore(
    window.sessionStorage.getItem(READ_STATE_SESSION_STORAGE_KEY)
  )
  if (fromSession) {
    const persisted = writePersistedReadStateStore(fromSession)
    if (persisted) {
      try {
        window.sessionStorage.removeItem(READ_STATE_SESSION_STORAGE_KEY)
      } catch {
        // Ignore storage failures; memory cache still works for the session.
      }
    }
    return fromSession
  }
  return { version: 2, entries: {} }
}

function writePersistedReadStateStore(store: PersistedReadStateStore): boolean {
  if (typeof window === 'undefined') return false
  const previousRaw = window.localStorage.getItem(READ_STATE_LOCAL_STORAGE_KEY)
  try {
    window.localStorage.setItem(READ_STATE_LOCAL_STORAGE_KEY, JSON.stringify(store))
    return true
  } catch (error) {
    console.warn(
      '[Wework] durable Codex plugin cache write failed; retrying with latest entry only',
      error
    )
  }
  // Quota / private-mode: keep a single latest snapshot so cold launches still paint.
  try {
    const latest = preferredPersistedReadStateEntry(store)
    if (!latest) return false
    const latestRaw = JSON.stringify({
      version: 2 as const,
      entries: { [latest.paramsKey]: latest },
    })
    try {
      window.localStorage.setItem(READ_STATE_LOCAL_STORAGE_KEY, latestRaw)
      return true
    } catch {
      // WebKit can reject replacement while the old value still occupies quota.
      // Free this exact cache key, retry the compact active snapshot, and restore
      // the previous atomic value if the retry still cannot be stored.
      window.localStorage.removeItem(READ_STATE_LOCAL_STORAGE_KEY)
      try {
        window.localStorage.setItem(READ_STATE_LOCAL_STORAGE_KEY, latestRaw)
        return true
      } catch (retryError) {
        if (previousRaw) {
          try {
            window.localStorage.setItem(READ_STATE_LOCAL_STORAGE_KEY, previousRaw)
          } catch {
            // Keep the newest snapshot in sessionStorage below.
          }
        }
        throw retryError
      }
    }
  } catch (error) {
    console.warn('[Wework] durable Codex plugin cache write failed', error)
    try {
      const latest = preferredPersistedReadStateEntry(store)
      if (latest) {
        window.sessionStorage.setItem(
          READ_STATE_SESSION_STORAGE_KEY,
          JSON.stringify({ version: 2 as const, entries: { [latest.paramsKey]: latest } })
        )
      }
    } catch {
      // Memory cache remains available until the WebView is destroyed.
    }
    return false
  }
}

function slimDurableAssetUrl(value?: string | null): string | null {
  if (!value) return null
  return value.startsWith('data:') && value.length > MAX_DURABLE_DATA_URL_CHARS ? null : value
}

function slimPluginInterfaceForDurableCache(
  value: PluginInterface | null | undefined
): PluginInterface | null {
  if (!value) return null
  // Remote OpenAI summaries often stash HTTPS icons on logo/logoDark after normalize.
  // Drop longDescription / screenshots / policy URLs to keep localStorage under quota.
  return {
    displayName: value.displayName ?? null,
    shortDescription: value.shortDescription ?? null,
    developerName: value.developerName ?? null,
    category: value.category ?? null,
    capabilities: value.capabilities,
    websiteUrl: value.websiteUrl ?? null,
    privacyPolicyUrl: value.privacyPolicyUrl ?? null,
    termsOfServiceUrl: value.termsOfServiceUrl ?? null,
    logo: slimDurableAssetUrl(value.logo),
    logoDark: slimDurableAssetUrl(value.logoDark),
    brandColor: value.brandColor ?? null,
  }
}

function slimPluginManifestForDurableCache(
  manifest: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!manifest) return {}
  const keys = [
    'name',
    'id',
    'marketplaceId',
    'source',
    'installPolicy',
    'authPolicy',
    'availability',
    'disabledReason',
    'eligiblePlanTypes',
  ] as const
  return Object.fromEntries(
    keys.flatMap(key => (manifest[key] === undefined ? [] : [[key, manifest[key]]]))
  )
}

function slimConnectorsForDurableCache(
  plugin: InstalledPlugin
): InstalledPlugin['spec']['components'] {
  return slimPluginComponentsForCache(plugin.spec.components)
}

/**
 * Persist a compact catalog snapshot so cold launches can paint OpenAI/local tabs
 * before plugin/list (~10s). Drop screenshots and keep skill/app/connector names
 * so plugin detail can show capabilities without waiting on plugin/read.
 */
function toDurableReadState(state: LocalCodexPluginsState): LocalCodexPluginsState {
  return {
    ...state,
    marketplaceItems: state.marketplaceItems.map(item => ({
      ...item,
      description:
        item.interface?.shortDescription?.trim() ||
        (item.description.length > 240 ? `${item.description.slice(0, 240)}…` : item.description),
      components: slimPluginComponentsForCache(item.components),
      interface: slimPluginInterfaceForDurableCache(item.interface),
      manifest: slimPluginManifestForDurableCache(item.manifest),
    })),
    installedPlugins: state.installedPlugins.map(plugin => ({
      ...plugin,
      spec: {
        ...plugin.spec,
        description:
          typeof plugin.spec.description === 'string' && plugin.spec.description.length > 240
            ? `${plugin.spec.description.slice(0, 240)}…`
            : plugin.spec.description,
        components: slimConnectorsForDurableCache(plugin),
        interface: slimPluginInterfaceForDurableCache(plugin.spec.interface),
        manifest: slimPluginManifestForDurableCache(plugin.spec.manifest),
      },
    })),
  }
}

function isOpenAiOfficialMarketplaceItem(item: PluginMarketplaceItem): boolean {
  const marketplaceId = item.manifest?.marketplaceId
  return typeof marketplaceId === 'string' && isOpenAiOfficialMarketplaceId(marketplaceId)
}

/**
 * An app-server reconnection can briefly return a successful but incomplete
 * plugin/list response after the desktop app resumes. Treat a missing OpenAI
 * marketplace as incomplete when the durable snapshot still has one: otherwise
 * that transient response permanently replaces the cache with an empty official
 * catalog and every later open looks like a first sync.
 */
function retainOpenAiOfficialCatalog(
  previous: LocalCodexPluginsState | null,
  next: LocalCodexPluginsState
): LocalCodexPluginsState {
  const previousOfficialMarketplaces = (previous?.marketplaces ?? []).filter(
    marketplace =>
      isOpenAiOfficialMarketplaceId(marketplace.id) ||
      isOpenAiOfficialMarketplaceId(marketplace.name)
  )
  const hasCurrentOfficialItems = next.marketplaceItems.some(isOpenAiOfficialMarketplaceItem)
  if (previousOfficialMarketplaces.length === 0 || hasCurrentOfficialItems) return next

  const existingItemIds = new Set(next.marketplaceItems.map(item => String(item.id)))
  const retainedItems = (previous?.marketplaceItems ?? []).filter(
    item => isOpenAiOfficialMarketplaceItem(item) && !existingItemIds.has(String(item.id))
  )
  const existingMarketplaceIds = new Set(next.marketplaces.map(marketplace => marketplace.id))
  const retainedMarketplaces = previousOfficialMarketplaces.filter(
    marketplace => !existingMarketplaceIds.has(marketplace.id)
  )
  console.warn(
    '[Wework] Codex plugin/list returned an incomplete OpenAI marketplace after resume; retaining cached catalog'
  )
  return {
    ...next,
    marketplaceItems: [...next.marketplaceItems, ...retainedItems],
    marketplaces: [...next.marketplaces, ...retainedMarketplaces],
  }
}

function persistReadStateSnapshot(
  paramsKey: string,
  state: LocalCodexPluginsState,
  cachedAt: number
) {
  const store = readPersistedReadStateStore()
  store.entries[paramsKey] = {
    paramsKey,
    cachedAt,
    state: toDurableReadState(state),
  }
  const retainedEntries = Object.entries(store.entries)
    .sort(([, left], [, right]) => right.cachedAt - left.cachedAt)
    .slice(0, MAX_DURABLE_READ_STATE_ENTRIES)
  store.entries = Object.fromEntries(retainedEntries)
  writePersistedReadStateStore(store)
}

function hydrateReadStateCacheFromSession(): void {
  if (didHydrateReadStateSession) return
  didHydrateReadStateSession = true
  if (cachedState) return
  const store = readPersistedReadStateStore()
  const entry = Object.values(store.entries).sort(
    (left, right) => right.cachedAt - left.cachedAt
  )[0]
  if (!entry) return
  if (Date.now() - entry.cachedAt > READ_STATE_DURABLE_TTL_MS) return
  cachedState = entry.state
  cachedStateAt = entry.cachedAt
  cachedStateParamsKey = entry.paramsKey
  cachedStateGeneration = Math.max(cachedStateGeneration, 1)
}

function rememberReadStateSnapshot(
  paramsKey: string,
  state: LocalCodexPluginsState,
  generation: number
): void {
  if (generation < cachedStateGeneration) return
  cachedState = state
  cachedStateGeneration = generation
  cachedStateAt = Date.now()
  cachedStateParamsKey = paramsKey
  persistReadStateSnapshot(paramsKey, state, cachedStateAt)
}

/** Returns the last local Codex marketplace snapshot without waiting on plugin/list. */
export function peekLocalCodexPluginsReadState(
  params: {
    marketplaceId?: string
    mergeAllMarketplaces?: boolean
  } = {}
): LocalCodexPluginsState | null {
  hydrateReadStateCacheFromSession()
  const paramsKey = readStateParamsKey(params)
  if (cachedState && cachedStateParamsKey === paramsKey) return cachedState
  const persisted = readPersistedReadStateStore().entries[paramsKey]
  if (!persisted) return null
  if (Date.now() - persisted.cachedAt > READ_STATE_DURABLE_TTL_MS) return null
  cachedState = persisted.state
  cachedStateAt = persisted.cachedAt
  cachedStateParamsKey = paramsKey
  return cachedState
}

export function isLocalCodexPluginsReadStateFresh(
  params: {
    marketplaceId?: string
    mergeAllMarketplaces?: boolean
  } = {}
): boolean {
  const peeked = peekLocalCodexPluginsReadState(params)
  if (!peeked) return false
  return Date.now() - cachedStateAt < READ_STATE_FRESH_TTL_MS
}

/**
 * Optionally warms Codex plugin/list into the durable cache.
 * Do not call this during app startup or chat: plugin/list (~10s) shares the Codex
 * app-server with turns and will stall send/response. Prefer localStorage peek +
 * loading the marketplace only when the Plugins page opens.
 */
export function warmLocalCodexPluginsReadState(): Promise<LocalCodexPluginsState> | null {
  if (!isDesktopRuntime()) return null
  if (!warmupReadStatePromise) {
    warmupReadStatePromise = readState({ mergeAllMarketplaces: true })
      .then(state => {
        console.info('[Wework] warmed local Codex plugin catalog', {
          marketplaceCount: state.marketplaces.length,
          itemCount: state.marketplaceItems.length,
        })
        return state
      })
      .catch(error => {
        console.warn('[Wework] warm local Codex plugin catalog failed', error)
        warmupReadStatePromise = null
        throw error
      })
  }
  return warmupReadStatePromise
}

function withFilteredMarketplaceItems(
  state: LocalCodexPluginsState,
  query?: string
): LocalCodexPluginsState {
  if (!query?.trim()) return state
  return {
    ...state,
    marketplaceItems: filterPluginItems(state.marketplaceItems, query),
  }
}

function requestPluginInstalled(options: { shareInflight?: boolean } = {}): Promise<{
  marketplaces: CodexPluginMarketplaceEntry[]
}> {
  if (options.shareInflight === false) {
    return codexAppServerRequest<{ marketplaces: CodexPluginMarketplaceEntry[] }>(
      'plugin/installed',
      {
        cwds: null,
        installSuggestionPluginNames: null,
      }
    )
  }
  if (!inflightPluginInstalled) {
    const request = codexAppServerRequest<{
      marketplaces: CodexPluginMarketplaceEntry[]
    }>('plugin/installed', {
      cwds: null,
      installSuggestionPluginNames: null,
    }).finally(() => {
      if (inflightPluginInstalled === request) {
        inflightPluginInstalled = null
      }
    })
    inflightPluginInstalled = request
  }
  return inflightPluginInstalled
}

async function codexAppServerRequest<T>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureLocalExecutorStarted()
  const startedAt = Date.now()
  try {
    const result = await requestLocalExecutor<T>('codex.app_server_request', {
      method,
      params,
    })
    const elapsedMs = Date.now() - startedAt
    // plugin/list and plugin/installed have been ~10s in production; keep a focused
    // breadcrumb so we can tell which nested method is still slow after local-kinds.
    if (method.startsWith('plugin/') || elapsedMs >= 1_000) {
      console.info('[Wework] codex.app_server_request', {
        method,
        elapsedMs,
        marketplaceKinds: params.marketplaceKinds ?? null,
      })
    }
    return result
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    console.warn('[Wework] codex.app_server_request failed', {
      method,
      elapsedMs,
      marketplaceKinds: params.marketplaceKinds ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
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

function matchesInstalledPluginTrialLookup(
  plugin: InstalledPlugin,
  lookupId: string | number
): boolean {
  const normalized = String(lookupId).trim()
  if (!normalized) return false
  const labelId = installedPluginId(plugin)
  if (labelId != null && String(labelId) === normalized) return true

  const payload = plugin.spec.sourcePayload
  const payloadRecord = payload && typeof payload === 'object' ? payload : {}
  const cloudInstalledId = payloadRecord.cloudInstalledPluginId
  if (cloudInstalledId != null && String(cloudInstalledId) === normalized) return true

  const pluginKey = plugin.spec.source.pluginKey.trim()
  const marketplace =
    (typeof payloadRecord.marketplaceName === 'string' && payloadRecord.marketplaceName.trim()) ||
    (typeof plugin.metadata.namespace === 'string' && plugin.metadata.namespace.trim()) ||
    plugin.spec.source.marketplace ||
    plugin.spec.source.providerKey
  if (pluginKey && typeof marketplace === 'string' && marketplace.trim()) {
    if (`${pluginKey}@${marketplace.trim()}` === normalized) return true
  }
  return pluginKey.toLowerCase() === normalized.toLowerCase()
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

export function installedPluginMatchesImportedPersonalPlugin(
  plugin: InstalledPlugin,
  pluginName: string
): boolean {
  const payload =
    plugin.spec.sourcePayload && typeof plugin.spec.sourcePayload === 'object'
      ? plugin.spec.sourcePayload
      : {}
  const marketplaceNames = [
    plugin.metadata.namespace,
    plugin.spec.source.marketplace,
    plugin.spec.source.providerKey,
    typeof payload.marketplaceName === 'string' ? payload.marketplaceName : '',
  ]
  return (
    plugin.spec.source.pluginKey === pluginName &&
    marketplaceNames.some(name => name === WEWORK_PERSONAL_MARKETPLACE_ID)
  )
}

function isLocalMarketplacePath(path: string | null | undefined): boolean {
  if (!path) return false
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

interface EnsurePersonalPluginResult {
  pluginName: string
  marketplacePath: string
  pluginPath: string
  migrated: boolean
}

async function resolveWeworkPersonalMarketplacePath(
  state?: LocalCodexPluginsState | null
): Promise<string> {
  const current = state ?? cachedState
  const marketplace = current?.marketplaces.find(item => item.id === WEWORK_PERSONAL_MARKETPLACE_ID)
  if (marketplace && isLocalMarketplacePath(marketplace.path)) {
    return normalizeMarketplaceSource(marketplace.path)
  }
  const bundled = getInitializedBundledPluginMarketplace()
  if (bundled?.path && isLocalMarketplacePath(bundled.path)) {
    return normalizeMarketplaceSource(bundled.path)
  }
  const loaded = await readState({ skipPersonalReconcile: true })
  const loadedMarketplace = loaded.marketplaces.find(
    item => item.id === WEWORK_PERSONAL_MARKETPLACE_ID
  )
  if (loadedMarketplace && isLocalMarketplacePath(loadedMarketplace.path)) {
    return normalizeMarketplaceSource(loadedMarketplace.path)
  }
  throw new Error(`The ${WEWORK_PERSONAL_MARKETPLACE_ID} marketplace is unavailable`)
}

async function uninstallWeworkPersonalPluginLocally(
  pluginName: string,
  marketplacePath: string
): Promise<void> {
  const commit = await requestLocalExecutor<LocalPluginInstallCommitResult>(
    'runtime.codex.plugin.uninstall_local',
    {
      marketplacePath: codexMarketplaceManifestSource(marketplacePath),
      pluginName,
    }
  )
  if (!commit.localCommitted) {
    throw new Error('Plugin did not reach its local uninstall commit')
  }
  clearLocalCodexPluginsReadStateCache()
  try {
    await unlinkLocalPluginRelease(marketplacePath, pluginName)
  } catch (error) {
    throw new LocalPluginUninstallCleanupError(
      getErrorMessage(error, 'Failed to unlink local plugin release'),
      { cause: error }
    )
  }
}

async function ensurePluginInWeworkPersonal(options: {
  sourceMarketplacePath: string
  pluginName: string
  installAfterMigrate?: boolean
}): Promise<EnsurePersonalPluginResult> {
  const destinationMarketplacePath = await resolveWeworkPersonalMarketplacePath()
  const ensured = await requestLocalExecutor<EnsurePersonalPluginResult>(
    'executor.plugins.personal.ensure',
    {
      sourceMarketplacePath: options.sourceMarketplacePath,
      destinationMarketplacePath,
      pluginName: options.pluginName,
    }
  )
  if (options.installAfterMigrate !== false && ensured.migrated) {
    try {
      await requestLocalExecutor('runtime.codex.plugin.install_local_first', {
        marketplacePath: codexMarketplaceManifestSource(ensured.marketplacePath),
        pluginName: ensured.pluginName,
      })
    } catch (error) {
      // Migration already landed on disk; install can be retried on the next refresh.
      console.warn('[Wework] Failed to install migrated personal plugin', error)
    }
  }
  // `migrated: false` is a read-only idempotent hit. Do not
  // erase the just-written OpenAI catalog on every personal-plugin reconciliation.
  // A real migration reloads and persists a fresh snapshot in readState below.
  if (ensured.migrated) clearLocalCodexPluginsReadStateCache()
  return ensured
}

async function reconcileCodexPersonalPlugins(state: LocalCodexPluginsState): Promise<boolean> {
  const candidates = state.installedPlugins.filter(plugin => {
    const marketplaceId = plugin.spec.source.marketplace || plugin.spec.source.providerKey || ''
    return marketplaceId === CODEX_PERSONAL_MARKETPLACE_ID
  })
  if (candidates.length === 0) return false

  let changed = false
  for (const plugin of candidates) {
    const sourcePayload = plugin.spec.sourcePayload ?? {}
    const pluginName =
      (typeof sourcePayload.pluginName === 'string' && sourcePayload.pluginName.trim()) ||
      plugin.spec.source.pluginKey
    let sourceMarketplacePath =
      typeof sourcePayload.marketplacePath === 'string' ? sourcePayload.marketplacePath.trim() : ''
    if (!sourceMarketplacePath) {
      const marketplace = state.marketplaces.find(
        item =>
          item.id === CODEX_PERSONAL_MARKETPLACE_ID || item.name === CODEX_PERSONAL_MARKETPLACE_ID
      )
      sourceMarketplacePath =
        marketplace && isLocalMarketplacePath(marketplace.path) ? marketplace.path : ''
    }
    if (!pluginName.trim() || !sourceMarketplacePath) continue
    try {
      const ensured = await ensurePluginInWeworkPersonal({
        sourceMarketplacePath,
        pluginName,
        installAfterMigrate: true,
      })
      if (ensured.migrated) changed = true
    } catch (error) {
      console.warn('[Wework] Failed to migrate Codex personal plugin', pluginName, error)
    }
  }
  return changed
}

function isCodexRemoteInstallPluginName(pluginId: string, pluginName?: string): boolean {
  const trimmed = pluginId.trim()
  // Reject catalog-qualified ids (gmail@openai-curated-remote) and namespaced
  // ids. Also reject bare catalog names equal to plugin.name — Codex remote
  // install needs connector-style ids like plugin_connector_1p_*.
  if (!trimmed || trimmed.includes('@') || trimmed.includes(':')) return false
  if (!/^[A-Za-z0-9_~-]+$/.test(trimmed)) return false
  const bareName = pluginName?.trim().toLowerCase() || ''
  if (bareName && trimmed.toLowerCase() === bareName) return false
  return true
}

function pluginInstallName(item: PluginMarketplaceItem, localMarketplace: boolean): string {
  if (localMarketplace) return item.name
  const remoteId = item.remotePluginId?.trim() || ''
  if (remoteId && isCodexRemoteInstallPluginName(remoteId, item.name)) return remoteId
  const bareName = item.name.trim()
  if (bareName) return bareName
  const catalogId = String(item.id).trim()
  const at = catalogId.lastIndexOf('@')
  if (at > 0) return catalogId.slice(0, at)
  const colon = catalogId.indexOf(':')
  if (colon >= 0 && colon < catalogId.length - 1) return catalogId.slice(colon + 1)
  return catalogId
}

function isRetriablePluginInstallCandidateError(message: string): boolean {
  return (
    /not found|unknown plugin|unexpected plugin id|invalid remote plugin id/i.test(message) ||
    /invalid plugin(?: name| id)?/i.test(message)
  )
}

function pushUniqueInstallCandidate(candidates: string[], value: string | null | undefined) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || candidates.includes(trimmed)) return
  candidates.push(trimmed)
}

async function resolveRemoteInstallPluginNames(
  marketplace: LocalCodexMarketplace,
  item: PluginMarketplaceItem
): Promise<string[]> {
  const candidates: string[] = []
  pushUniqueInstallCandidate(
    candidates,
    item.remotePluginId && isCodexRemoteInstallPluginName(item.remotePluginId, item.name)
      ? item.remotePluginId
      : ''
  )
  const catalogId = String(item.id).trim()
  if (isCodexRemoteInstallPluginName(catalogId, item.name)) {
    pushUniqueInstallCandidate(candidates, catalogId)
  }

  // plugin/list often omits remotePluginId and only returns gmail@marketplace /
  // bare gmail. plugin/read carries the connector-style id needed for install.
  if (candidates.length === 0) {
    try {
      const detail = await readPluginDetail(marketplace, item.name)
      const summary = detail.summary
      pushUniqueInstallCandidate(
        candidates,
        summary?.remotePluginId && isCodexRemoteInstallPluginName(summary.remotePluginId, item.name)
          ? summary.remotePluginId
          : ''
      )
      pushUniqueInstallCandidate(
        candidates,
        summary?.id && isCodexRemoteInstallPluginName(summary.id, item.name) ? summary.id : ''
      )
    } catch (error) {
      console.warn('[Wework plugins] failed to resolve remote install plugin id', {
        marketplaceId: marketplace.id,
        pluginName: item.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  pushUniqueInstallCandidate(candidates, item.name)
  return candidates
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

type PersonalMarketplacePluginSummary = {
  name: string
  version?: string | null
  displayName?: string | null
  description?: string | null
  logo?: string | null
  category?: string | null
  marketplacePath?: string | null
  pluginPath: string
}

type PersonalMarketplaceListResult = {
  marketplaceId: string
  marketplacePath: string
  plugins: PersonalMarketplacePluginSummary[]
}

type WegentStorePluginSummary = {
  name: string
  packageId: string
  marketplace: string
  version?: string | null
  enabled: boolean
  displayName?: string | null
  description?: string | null
  logo?: string | null
  category?: string | null
  pluginPath: string
}

type WegentStoreListResult = {
  storePath: string
  plugins: WegentStorePluginSummary[]
}

function toDiskPersonalMarketplaceItem(
  plugin: PersonalMarketplacePluginSummary,
  marketplacePath: string
): PluginMarketplaceItem {
  const displayName = plugin.displayName?.trim() || plugin.name
  const description = plugin.description?.trim() || ''
  return {
    id: `personal-disk:${plugin.name}`,
    remotePluginId: plugin.name,
    name: plugin.name,
    displayName,
    description,
    version: plugin.version ?? null,
    author: null,
    visibility: 'personal',
    featured: false,
    installed: false,
    installedPluginId: null,
    installedLocally: false,
    enabled: false,
    sourceType: 'marketplace',
    interface: {
      displayName,
      shortDescription: description,
      logo: plugin.logo ?? null,
      category: plugin.category ?? null,
    },
    components: emptyComponents(),
    manifest: {
      name: plugin.name,
      marketplaceId: WEWORK_PERSONAL_MARKETPLACE_ID,
      marketplacePath,
      source: {
        source: 'local',
        path: plugin.pluginPath || `./plugins/${plugin.name}`,
      },
    },
    ownerUserId: 0,
    sourceProvider: 'user',
    sourceLabel: i18n.t('workbench.plugins_source_personal_share'),
  }
}

/**
 * Lists wework-personal plugins from disk. Avoids Codex plugin/list (~10s reconcile)
 * so the personal-created tab can paint before app-server finishes.
 *
 * Does not wait for Codex app-server startup: Executor only reads disk and resolves
 * a default marketplace path when the in-memory bundled path is missing.
 */
export async function listPersonalMarketplacePluginsFromDisk(): Promise<PluginMarketplaceItem[]> {
  if (!isElectronRuntime()) {
    console.info('[Wework] personal marketplace disk list skipped', { reason: 'not-electron' })
    return []
  }
  const marketplacePath = getInitializedBundledPluginMarketplace()?.path?.trim() || ''
  const listed = await requestLocalExecutor<PersonalMarketplaceListResult>(
    'executor.plugins.personal.list',
    { marketplacePath }
  ).catch(error => {
    console.warn('[Wework] list personal marketplace from disk failed', error)
    return null
  })
  if (!listed) return []
  if (!listed.plugins.length) {
    console.info('[Wework] personal marketplace disk list empty', {
      marketplacePath: listed.marketplacePath || marketplacePath || null,
    })
    return []
  }
  console.info('[Wework] personal marketplace disk list', {
    marketplacePath: listed.marketplacePath || marketplacePath || null,
    count: listed.plugins.length,
    names: listed.plugins.map(plugin => plugin.name),
  })
  return listed.plugins.map(plugin =>
    toDiskPersonalMarketplaceItem(
      plugin,
      plugin.marketplacePath ||
        listed.marketplacePath ||
        marketplacePath ||
        WEWORK_PERSONAL_MARKETPLACE_ID
    )
  )
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

function featuredPluginIdSet(featuredPluginIds: string[] | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const value of featuredPluginIds ?? []) {
    const trimmed = String(value || '').trim()
    if (trimmed) ids.add(trimmed)
  }
  return ids
}

function isFeaturedMarketplacePlugin(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  featuredIds: Set<string>
): boolean {
  if (featuredIds.size === 0) return false
  const candidates = [
    plugin.id,
    plugin.remotePluginId,
    plugin.name,
    catalogItemId(marketplace, plugin),
    `${plugin.name}@${marketplace.name}`,
  ]
  return candidates.some(candidate => {
    const value = String(candidate || '').trim()
    return value !== '' && featuredIds.has(value)
  })
}

function localMarketplaceSource(marketplace: CodexPluginMarketplaceEntry): {
  sourceProvider: 'wegent' | 'codex' | 'user'
  sourceLabel: string
  visibility: 'personal' | 'workspace' | 'public'
} {
  if (isPersonalMarketplaceId(marketplace.name)) {
    return {
      sourceProvider: 'user',
      sourceLabel: i18n.t('workbench.plugins_source_personal_share'),
      visibility: 'personal',
    }
  }
  if (isInternalDeviceMarketplaceId(marketplace.name)) {
    return {
      sourceProvider: 'wegent',
      sourceLabel: i18n.t('workbench.plugins_source_wegent_official'),
      visibility: 'workspace',
    }
  }
  if (isOpenAiOfficialMarketplaceId(marketplace.name)) {
    return {
      sourceProvider: 'codex',
      sourceLabel: i18n.t('workbench.plugins_source_openai_official'),
      visibility: 'public',
    }
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
    description: app.description ?? null,
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
  const declaredConnectors = detail.connectors ?? []
  const inferredConnectors: CodexPluginConnector[] =
    declaredConnectors.length === 0 &&
    detail.summary.authPolicy?.trim().toLowerCase() === 'on_install'
      ? (detail.apps ?? [])
          .filter(app => app.required !== false)
          .map(app => ({
            slug:
              app.slug?.trim() ||
              app.name
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') ||
              detail.summary.name,
            authPolicy: 'on_install' as const,
          }))
      : []
  components.connectors = [...declaredConnectors, ...inferredConnectors].map(connector => {
    const localAuth = connector.localAuth
    return {
      slug: connector.slug,
      authPolicy:
        connector.authPolicy === 'on_install' ||
        connector.authPolicy === 'on_use' ||
        connector.authPolicy === 'optional'
          ? connector.authPolicy
          : 'optional',
      description: connector.description ?? null,
      localAuth:
        localAuth?.health &&
        localAuth.start &&
        (localAuth.kind === 'browser_oauth' || localAuth.poll)
          ? {
              ...localAuth,
              health: localAuth.health,
              start: localAuth.start,
              poll: localAuth.poll ?? [],
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

function safeRelativePluginAssetPath(value: string): string | null {
  const segments = value.replace(/\\/g, '/').split('/')
  const safeSegments: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    safeSegments.push(segment)
  }
  return safeSegments.length > 0 ? safeSegments.join('/') : null
}

function isRelativePluginAssetPath(value: string): boolean {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  return !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
}

function localPluginRoot(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): string | null {
  if (marketplace.path && isLocalMarketplacePath(marketplace.path)) {
    const sourcePath =
      plugin.source && typeof plugin.source.path === 'string' ? plugin.source.path.trim() : ''
    if (sourcePath) {
      if (isLocalMarketplacePath(sourcePath)) return sourcePath.replace(/[\\/]+$/, '')
      const relativeSourcePath = safeRelativePluginAssetPath(sourcePath)
      if (relativeSourcePath) {
        return `${normalizeMarketplaceSource(marketplace.path).replace(/[\\/]+$/, '')}/${relativeSourcePath}`
      }
    }
  }

  for (const path of (detail?.skills ?? []).map(skill => skill.path)) {
    if (!path || !isLocalMarketplacePath(path)) continue
    const normalized = path.replace(/\\/g, '/')
    const skillsIndex = normalized.lastIndexOf('/skills/')
    if (skillsIndex > 0) return normalized.slice(0, skillsIndex)
  }
  return null
}

type CodexPluginInterfaceAssets = PluginInterface & {
  logoUrl?: string | null
  logoUrlDark?: string | null
  composerIconUrl?: string | null
  screenshotUrls?: string[] | null
  homepageUrl?: string | null
  homepage?: string | null
  privacyPolicy?: string | null
  termsOfService?: string | null
}

function firstPluginAssetUrl(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (value) return value
  }
  return null
}

function normalizePluginInterfaceAssets(interfaceData: PluginInterface): PluginInterface {
  const raw = interfaceData as CodexPluginInterfaceAssets
  const screenshots =
    raw.screenshots && raw.screenshots.length > 0
      ? raw.screenshots
      : raw.screenshotUrls && raw.screenshotUrls.length > 0
        ? raw.screenshotUrls
        : raw.screenshots
  return {
    ...interfaceData,
    composerIcon: firstPluginAssetUrl(raw.composerIcon, raw.composerIconUrl),
    logo: firstPluginAssetUrl(raw.logo, raw.logoUrl),
    logoDark: firstPluginAssetUrl(raw.logoDark, raw.logoUrlDark),
    websiteUrl: firstPluginAssetUrl(raw.websiteUrl, raw.homepageUrl, raw.homepage),
    privacyPolicyUrl: firstPluginAssetUrl(raw.privacyPolicyUrl, raw.privacyPolicy),
    termsOfServiceUrl: firstPluginAssetUrl(raw.termsOfServiceUrl, raw.termsOfService),
    screenshots,
  }
}

function resolvePluginInterfaceAssets(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): PluginInterface | null {
  const interfaceData = plugin.interface
  if (!interfaceData) return null
  const normalized = normalizePluginInterfaceAssets(interfaceData)
  const root = localPluginRoot(marketplace, plugin, detail)
  if (!root) return normalized
  const resolve = (value?: string | null): string | null | undefined => {
    const source = value?.trim()
    if (!source || !isRelativePluginAssetPath(source)) return value
    const relativePath = safeRelativePluginAssetPath(source)
    return relativePath ? `${root}/${relativePath}` : null
  }
  return {
    ...normalized,
    composerIcon: resolve(normalized.composerIcon),
    logo: resolve(normalized.logo),
    logoDark: resolve(normalized.logoDark),
    screenshots: normalized.screenshots?.map(screenshot => resolve(screenshot) || screenshot),
  }
}

function toMarketplaceItem(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null,
  featuredIds: Set<string> = new Set()
): PluginMarketplaceItem {
  const components = pluginComponents(detail)
  const source = localMarketplaceSource(marketplace)
  const resolvedInterface = resolvePluginInterfaceAssets(marketplace, plugin, detail)
  const pluginInterface = resolvedInterface as
    | (PluginInterface & {
        tags?: string[]
        keywords?: string[]
        categories?: string[]
      })
    | null
    | undefined
  const remotePluginId =
    (typeof plugin.remotePluginId === 'string' &&
    isCodexRemoteInstallPluginName(plugin.remotePluginId, plugin.name)
      ? plugin.remotePluginId.trim()
      : '') ||
    (typeof plugin.id === 'string' && isCodexRemoteInstallPluginName(plugin.id, plugin.name)
      ? plugin.id.trim()
      : '') ||
    ''
  return {
    id: catalogItemId(marketplace, plugin),
    remotePluginId,
    name: plugin.name,
    displayName: pluginDisplayName(plugin),
    description: pluginDescription(plugin, detail),
    version: plugin.localVersion ?? null,
    author: resolvedInterface?.developerName ?? null,
    visibility: source.visibility,
    featured: isFeaturedMarketplacePlugin(marketplace, plugin, featuredIds),
    installed: plugin.installed,
    installedPluginId: plugin.installed ? plugin.id : null,
    enabled: plugin.enabled,
    sourceType: 'marketplace',
    interface: resolvedInterface,
    components,
    manifest: {
      name: plugin.name,
      id: plugin.id,
      marketplaceId: marketplace.name,
      marketplacePath: marketplace.path ?? null,
      source: plugin.source ?? null,
      installPolicy: plugin.installPolicy ?? null,
      authPolicy: plugin.authPolicy ?? null,
      availability: plugin.availability ?? null,
      disabledReason: plugin.disabledReason ?? null,
      eligiblePlanTypes: plugin.eligiblePlanTypes ?? null,
      tags: pluginInterface?.tags ?? [],
      keywords: [...(plugin.keywords ?? []), ...(pluginInterface?.keywords ?? [])],
      categories: pluginInterface?.categories ?? [],
    },
    ownerUserId: 0,
    sourceProvider: source.sourceProvider,
    sourceLabel: source.sourceLabel,
  }
}

function installedPluginSummaryIdentity(
  marketplaceName: string,
  plugin: CodexPluginSummary
): string {
  const pluginKey = String(plugin.name || plugin.id || '')
    .trim()
    .toLowerCase()
  const marketplace = marketplaceName.trim().toLowerCase()
  return pluginKey && marketplace ? `${pluginKey}@${marketplace}` : ''
}

function mergeInstalledPluginSummaries(
  installedMarketplaces: CodexPluginMarketplaceEntry[],
  availableMarketplaces: CodexPluginMarketplaceEntry[]
): InstalledPlugin[] {
  const merged = new Map<string, InstalledPlugin>()
  const add = (marketplace: CodexPluginMarketplaceEntry, plugin: CodexPluginSummary) => {
    const normalized: CodexPluginSummary = {
      ...plugin,
      id: plugin.id?.trim() || plugin.name,
      installed: true,
      // Missing enabled in installed summaries should not hide the plugin from composer.
      enabled: plugin.enabled !== false,
    }
    const identity =
      installedPluginSummaryIdentity(marketplace.name, normalized) ||
      `id:${normalized.id || normalized.name}`
    if (!merged.has(identity)) {
      merged.set(identity, toInstalledPlugin(marketplace, normalized))
    }
  }

  for (const marketplace of installedMarketplaces) {
    for (const plugin of marketplace.plugins) {
      add(marketplace, plugin)
    }
  }
  for (const marketplace of availableMarketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!plugin.installed) continue
      add(marketplace, plugin)
    }
  }
  return Array.from(merged.values())
}

function toWegentStoreInstalledPlugin(
  plugin: WegentStorePluginSummary,
  storePath: string
): InstalledPlugin {
  const marketplace = isWegentCloudMarketplace(plugin.marketplace)
    ? INTERNAL_DEVICE_MARKETPLACE_ID
    : plugin.marketplace
  return toInstalledPlugin(
    {
      name: marketplace,
      path: storePath || plugin.pluginPath,
      plugins: [],
    },
    {
      id: plugin.packageId,
      name: plugin.name,
      installed: true,
      enabled: plugin.enabled,
      localVersion: plugin.version ?? undefined,
      source: {
        source: 'local',
        path: plugin.pluginPath,
      },
      interface: {
        displayName: plugin.displayName?.trim() || plugin.name,
        shortDescription: plugin.description ?? null,
        logo: plugin.logo ?? null,
        category: plugin.category ?? null,
      },
    }
  )
}

/**
 * Lists packages referenced by the active capability manifest. Avoids Codex
 * plugin/list so installed enterprise ZIPs can paint without scanning caches.
 */
export async function listWegentStorePluginsFromDisk(): Promise<InstalledPlugin[]> {
  if (!isElectronRuntime()) return []
  if (inflightWegentStoreList) return inflightWegentStoreList
  const pending = requestLocalExecutor<WegentStoreListResult>('executor.plugins.store.list')
    .catch(error => {
      console.warn('[Wework] list wegent store plugins from disk failed', error)
      return null
    })
    .then(listed => {
      if (!listed?.plugins?.length) {
        if (listed) {
          console.info('[Wework] wegent store disk list empty', {
            storePath: listed.storePath || null,
          })
        }
        return [] as InstalledPlugin[]
      }
      console.info('[Wework] wegent store disk list', {
        storePath: listed.storePath || null,
        count: listed.plugins.length,
        names: listed.plugins.map(plugin => plugin.name),
      })
      return listed.plugins.map(plugin =>
        toWegentStoreInstalledPlugin(plugin, listed.storePath || plugin.pluginPath)
      )
    })
    .finally(() => {
      if (inflightWegentStoreList === pending) inflightWegentStoreList = null
    })
  inflightWegentStoreList = pending
  return pending
}

function toInstalledPlugin(
  marketplace: CodexPluginMarketplaceEntry,
  plugin: CodexPluginSummary,
  detail?: CodexPluginDetail | null
): InstalledPlugin {
  const components = pluginComponents(detail)
  const resolvedInterface = resolvePluginInterfaceAssets(marketplace, plugin, detail)
  const isCreated = isPersonalMarketplaceId(marketplace.name)
  const source = localMarketplaceSource(marketplace)
  const skillStates = Object.fromEntries(
    (detail?.skills ?? []).map(skill => [`skill:${skill.name}`, skill.enabled])
  )
  const pluginId = plugin.id?.trim() || plugin.name
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: plugin.name,
      namespace: marketplace.name,
      labels: { id: pluginId },
    },
    spec: {
      source: {
        type: isCreated ? 'local' : 'marketplace',
        providerKey: marketplace.name,
        pluginKey: plugin.name,
        catalogItemId: plugin.remotePluginId ?? pluginId,
        marketplace: marketplace.name,
      },
      origin: isCreated ? 'created' : 'market',
      sourceProvider: source.sourceProvider,
      sourceLabel: source.sourceLabel,
      visibility: source.visibility,
      displayName: pluginDisplayName(plugin),
      description: pluginDescription(plugin, detail),
      version: plugin.localVersion ?? null,
      author: resolvedInterface?.developerName ?? null,
      installState: plugin.installed ? 'installed' : 'not_installed',
      enabled: plugin.enabled !== false,
      componentStates: skillStates,
      manifest: {
        name: plugin.name,
        id: pluginId,
        source: plugin.source ?? null,
        installPolicy: plugin.installPolicy ?? null,
        authPolicy: plugin.authPolicy ?? null,
        availability: plugin.availability ?? null,
        disabledReason: plugin.disabledReason ?? null,
        eligiblePlanTypes: plugin.eligiblePlanTypes ?? null,
      },
      components,
      interface: resolvedInterface,
      packageRef: null,
      sourcePayload: {
        ...sourcePayload(marketplace, plugin),
        localId: isCreated ? pluginId : null,
      },
    },
    status: { state: plugin.enabled !== false ? 'enabled' : 'disabled' },
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
  if (!localMarketplace) return response.plugin

  try {
    const manifest = await requestLocalExecutor<{ connectors?: CodexPluginConnector[] }>(
      'executor.plugins.manifest.read',
      {
        marketplacePath: marketplace.path,
        pluginName,
      }
    )
    const connectors = manifest?.connectors
    if (!connectors || connectors.length === 0) return response.plugin
    return {
      ...response.plugin,
      connectors: response.plugin.connectors?.length ? response.plugin.connectors : connectors,
    }
  } catch (error) {
    console.warn('[Wework plugins] failed to read local plugin manifest', {
      marketplaceId: marketplace.id,
      pluginName,
      error: getErrorMessage(error, 'unknown error'),
    })
    return response.plugin
  }
}

function filterPluginItems(
  items: PluginMarketplaceItem[],
  query?: string
): PluginMarketplaceItem[] {
  return rankMarketplaceSearchResults(items, query ?? '')
}

export function applyPluginCloudLinks(
  installedPlugins: InstalledPlugin[],
  cloudLinks: LocalPluginCloudLink[]
): InstalledPlugin[] {
  if (cloudLinks.length === 0) return installedPlugins
  const linksByPluginName = new Map(cloudLinks.map(link => [link.localPluginName, link]))
  return installedPlugins.map(plugin => {
    const sourcePayload = plugin.spec.sourcePayload ?? {}
    const marketplaceName =
      plugin.spec.source.marketplace ||
      (typeof sourcePayload.marketplaceName === 'string' ? sourcePayload.marketplaceName : '') ||
      plugin.spec.source.providerKey
    if (!isPersonalMarketplaceId(marketplaceName)) return plugin
    const pluginName =
      (typeof sourcePayload.pluginName === 'string' && sourcePayload.pluginName.trim()) ||
      plugin.spec.source.pluginKey
    const link = linksByPluginName.get(pluginName)
    if (!link) return plugin
    return {
      ...plugin,
      spec: {
        ...plugin.spec,
        sourcePayload: {
          ...sourcePayload,
          cloudPluginId: link.cloudPluginId,
          cloudReleaseId: link.cloudReleaseId,
        },
      },
    }
  })
}

function pluginMarketplaceIdentity(pluginName: string, marketplaceName: string): string {
  const plugin = pluginName.trim().toLowerCase()
  const rawMarketplace = marketplaceName.trim().toLowerCase()
  const marketplace = isPersonalMarketplaceId(rawMarketplace)
    ? WEWORK_PERSONAL_MARKETPLACE_ID
    : isWegentCloudMarketplace(rawMarketplace)
      ? INTERNAL_DEVICE_MARKETPLACE_ID
      : rawMarketplace
  return plugin && marketplace ? `${plugin}@${marketplace}` : ''
}

/** UI catalog rows for user-added markets use `${marketplace}:${codexPluginId}`. */
function splitNamespacedCatalogPluginId(
  pluginId: string
): { marketplaceName: string; innerId: string } | null {
  const trimmedId = pluginId.trim()
  const separator = trimmedId.indexOf(':')
  if (separator <= 0 || separator >= trimmedId.length - 1) return null
  const marketplaceName = trimmedId.slice(0, separator).trim()
  const innerId = trimmedId.slice(separator + 1).trim()
  // Marketplace ids are slug-like; skip Windows paths / URLs.
  if (!marketplaceName || !innerId) return null
  if (/[\\/]/.test(marketplaceName) || marketplaceName.includes('://')) return null
  return { marketplaceName, innerId }
}

function denamespacedCatalogPluginId(pluginId: string, marketplaceName: string): string {
  const trimmedMarketplace = marketplaceName.trim()
  if (!trimmedMarketplace) return splitNamespacedCatalogPluginId(pluginId)?.innerId ?? ''
  const split = splitNamespacedCatalogPluginId(pluginId)
  if (!split || split.marketplaceName !== trimmedMarketplace) return ''
  return split.innerId
}

/**
 * Codex treats ids matching `[A-Za-z0-9_-~]+` as remote ChatGPT plugin ids.
 * Bare local plugin names (e.g. `desktop-e2e-plugin`) match and incorrectly
 * require remote-catalog auth during uninstall.
 */
function looksLikeCodexRemotePluginId(pluginId: string): boolean {
  const trimmed = pluginId.trim()
  return trimmed.length > 0 && /^[A-Za-z0-9_~-]+$/.test(trimmed)
}

function isRetriablePluginUninstallCandidateError(message: string): boolean {
  return (
    /not found|not installed|unknown plugin|unexpected plugin id/i.test(message) ||
    /invalid remote plugin id/i.test(message) ||
    // After unrestricted plugin/list syncs openai-curated-remote, Codex may try to
    // resolve the remote catalog while probing a bare/namespaced uninstall id.
    /chatgpt authentication required for remote plugin catalog/i.test(message) ||
    /resolve remote plugin before uninstall/i.test(message)
  )
}

function resolveLocalUninstallIdentity(input: {
  requestedId: string
  pluginName: string
  marketplaceName: string
  remotePluginId: string
  marketplaceItemId: string
  installedId: string
}): { pluginName: string; marketplaceName: string; qualifiedId: string } {
  let marketplaceName = input.marketplaceName.trim()
  let pluginName = input.pluginName.trim()

  for (const candidate of [
    input.requestedId,
    input.marketplaceItemId,
    input.installedId,
    input.remotePluginId,
  ]) {
    const namespaced = splitNamespacedCatalogPluginId(candidate)
    if (namespaced) {
      if (!marketplaceName) marketplaceName = namespaced.marketplaceName
      const at = namespaced.innerId.indexOf('@')
      const innerName = at > 0 ? namespaced.innerId.slice(0, at) : namespaced.innerId
      if (!pluginName || looksLikeCodexRemotePluginId(pluginName) || pluginName.includes(':')) {
        pluginName = innerName
      }
      if (!marketplaceName && at > 0) {
        marketplaceName = namespaced.innerId.slice(at + 1)
      }
      continue
    }
    const at = candidate.trim().indexOf('@')
    if (at <= 0) continue
    if (!pluginName || looksLikeCodexRemotePluginId(pluginName)) {
      pluginName = candidate.trim().slice(0, at)
    }
    if (!marketplaceName) marketplaceName = candidate.trim().slice(at + 1)
  }

  const qualifiedId =
    pluginName && marketplaceName && !pluginName.includes('@')
      ? `${pluginName}@${marketplaceName}`
      : pluginName.includes('@')
        ? pluginName
        : ''
  return { pluginName, marketplaceName, qualifiedId }
}

/**
 * Build uninstall id probes for Codex plugin/uninstall.
 * Local markets must use `name@marketplace`. Bare alphanumeric ids are remote
 * ChatGPT plugin ids and must not be probed for local uninstalls.
 */
function buildPluginUninstallCandidateIds(input: {
  requestedId: string
  pluginName: string
  marketplaceName: string
  remotePluginId: string
  marketplaceItemId: string
  installedId: string
}): string[] {
  const resolved = resolveLocalUninstallIdentity(input)
  const denamespacedRequested = denamespacedCatalogPluginId(
    input.requestedId,
    resolved.marketplaceName
  )
  const denamespacedItem = denamespacedCatalogPluginId(
    input.marketplaceItemId,
    resolved.marketplaceName
  )
  const remoteOpenAi = isOpenAiOfficialMarketplaceId(resolved.marketplaceName)
  const localNativeIds = [
    resolved.qualifiedId,
    denamespacedRequested.includes('@') ? denamespacedRequested : '',
    denamespacedItem.includes('@') ? denamespacedItem : '',
    input.installedId.includes('@') ? input.installedId : '',
    input.requestedId.includes('@') && !input.requestedId.includes(':') ? input.requestedId : '',
    // If denamespaced inner id is bare, rebuild the qualified local id.
    denamespacedRequested && !denamespacedRequested.includes('@') && resolved.marketplaceName
      ? `${denamespacedRequested}@${resolved.marketplaceName}`
      : '',
    denamespacedItem && !denamespacedItem.includes('@') && resolved.marketplaceName
      ? `${denamespacedItem}@${resolved.marketplaceName}`
      : '',
  ]
  const ordered = remoteOpenAi
    ? [
        // Remote OpenAI installs often require the connector-style remotePluginId.
        input.remotePluginId,
        ...localNativeIds,
        input.requestedId,
        input.pluginName,
        input.marketplaceItemId,
        input.installedId,
      ]
    : [
        ...localNativeIds,
        // Keep non-remote-shaped leftovers last; never probe bare remote-shaped
        // local names — they force ChatGPT remote-catalog auth.
        !looksLikeCodexRemotePluginId(input.remotePluginId) ? input.remotePluginId : '',
        !looksLikeCodexRemotePluginId(input.requestedId) && !input.requestedId.includes(':')
          ? input.requestedId
          : '',
      ]
  return Array.from(new Set(ordered.filter(value => Boolean(value && String(value).trim()))))
}

function marketplaceItemInstallIdentity(item: PluginMarketplaceItem): string {
  const marketplaceId =
    typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId : ''
  // Cloud Wework listings often omit marketplaceId; treat release-backed rows as wegent
  // so local wegent installs (快速建站 etc.) overlay onto the catalog card immediately.
  const marketplaceName =
    marketplaceId || (item.latestReleaseId != null ? INTERNAL_DEVICE_MARKETPLACE_ID : '')
  return pluginMarketplaceIdentity(item.name, marketplaceName)
}

export function applyInstalledPluginsToMarketplaceItems(
  items: PluginMarketplaceItem[],
  installedPlugins: InstalledPlugin[]
): PluginMarketplaceItem[] {
  const installedByIdentity = new Map<string, InstalledPlugin>()
  for (const plugin of installedPlugins) {
    const marketplace =
      plugin.spec.source.marketplace ||
      plugin.spec.source.providerKey ||
      (typeof plugin.spec.sourcePayload?.marketplaceName === 'string'
        ? plugin.spec.sourcePayload.marketplaceName
        : plugin.metadata.namespace)
    const marketplaceName = typeof marketplace === 'string' ? marketplace : ''
    const identity = pluginMarketplaceIdentity(
      String(plugin.spec.source.pluginKey || plugin.metadata.name || ''),
      marketplaceName
    )
    if (identity) installedByIdentity.set(identity, plugin)
  }

  return items.map(item => {
    const installed = installedByIdentity.get(marketplaceItemInstallIdentity(item))
    if (!installed) {
      const marketplaceId =
        typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId : ''
      if (item.installed && isOpenAiOfficialRemoteMarketplaceId(marketplaceId)) {
        return {
          ...item,
          installed: false,
          installedLocally: false,
          installedPluginId: null,
          enabled: false,
        }
      }
      return item
    }
    const id = installedPluginId(installed)
    const installedLocally =
      typeof installed.spec.pluginId !== 'number' ||
      installed.spec.sourcePayload?.localPresent === true
    const installedVersion =
      (typeof installed.spec.sourcePayload?.localVersion === 'string'
        ? installed.spec.sourcePayload.localVersion.trim()
        : '') ||
      installed.spec.version?.trim() ||
      null
    const catalogVersion = (item.version ?? '').trim()
    const localVersionLags = Boolean(
      installedVersion && catalogVersion && installedVersion !== catalogVersion
    )
    if (
      item.installed &&
      item.installedPluginId != null &&
      !installedLocally &&
      item.enabled === installed.spec.enabled &&
      !localVersionLags
    ) {
      return item
    }
    return {
      ...item,
      installed: true,
      installedPluginId:
        typeof id === 'string' || typeof id === 'number' ? id : item.installedPluginId,
      installedLocally: item.installedLocally || installedLocally,
      installedVersion: installedVersion || item.installedVersion || null,
      enabled: installed.spec.enabled,
      updateAvailable: Boolean(item.updateAvailable) || localVersionLags,
      currentDeviceInstallation: item.currentDeviceInstallation,
    }
  })
}

async function readState(
  params: {
    query?: string
    marketplaceId?: string
    mergeAllMarketplaces?: boolean
    refresh?: boolean
    skipPersonalReconcile?: boolean
  } = {}
): Promise<LocalCodexPluginsState> {
  if (!isDesktopRuntime()) return emptyState
  hydrateReadStateCacheFromSession()
  const paramsKey = readStateParamsKey(params)
  if (
    !params.refresh &&
    cachedState &&
    cachedStateParamsKey === paramsKey &&
    Date.now() - cachedStateAt < READ_STATE_FRESH_TTL_MS
  ) {
    return withFilteredMarketplaceItems(cachedState, params.query)
  }

  const existingInflight = !params.refresh ? inflightReadState.get(paramsKey) : undefined
  if (existingInflight) {
    // Stale-while-revalidate: if we already have a snapshot, paint it now while the
    // in-flight plugin/list (~10s) finishes. Callers that need a hard refresh pass
    // refresh: true and wait on the network path below.
    if (!params.refresh && cachedState && cachedStateParamsKey === paramsKey) {
      return withFilteredMarketplaceItems(cachedState, params.query)
    }
    return withFilteredMarketplaceItems(await existingInflight, params.query)
  }

  if (!params.refresh && cachedState && cachedStateParamsKey === paramsKey) {
    const loadPromise = loadReadStateSnapshot(params, paramsKey)
    inflightReadState.set(paramsKey, loadPromise)
    void loadPromise
      .catch(error => {
        console.warn('[Wework] background local Codex plugin refresh failed', error)
      })
      .finally(() => {
        if (inflightReadState.get(paramsKey) === loadPromise) {
          inflightReadState.delete(paramsKey)
        }
      })
    return withFilteredMarketplaceItems(cachedState, params.query)
  }

  const loadPromise = loadReadStateSnapshot(params, paramsKey)
  inflightReadState.set(paramsKey, loadPromise)
  try {
    const state = await loadPromise
    return withFilteredMarketplaceItems(state, params.query)
  } finally {
    if (inflightReadState.get(paramsKey) === loadPromise) {
      inflightReadState.delete(paramsKey)
    }
  }
}

async function loadReadStateSnapshot(
  params: {
    marketplaceId?: string
    mergeAllMarketplaces?: boolean
    refresh?: boolean
    skipPersonalReconcile?: boolean
  },
  paramsKey: string
): Promise<LocalCodexPluginsState> {
  const generation = nextReadStateGeneration++
  const executorStatus = await ensureLocalExecutorStarted()
  await ensureBundledPluginMarketplaceRegistered()
  const storePluginsPromise = listWegentStorePluginsFromDisk()
  const requestedMarketplaceId = params.mergeAllMarketplaces
    ? ''
    : params.marketplaceId?.trim() || selectedMarketplaceId()
  // Membership first. Unrestricted plugin/list reconciles github.com/openai/plugins
  // on the shared Codex app-server; starting it in the same Promise.all starved
  // plugin/installed whenever GitHub was slow, so Wework/official cards stayed
  // "同步中" until a VPN unblocked the OpenAI catalog.
  const installedResponse = await requestPluginInstalled()
  const availableResponse = await codexAppServerRequest<{
    marketplaces: CodexPluginMarketplaceEntry[]
    featuredPluginIds?: string[]
  }>('plugin/list', {
    cwds: null,
  })
  const availableMarketplaces = withInitializedBundledMarketplace(availableResponse.marketplaces)
  const featuredIds = featuredPluginIdSet(availableResponse.featuredPluginIds)
  const requestedSelectedId = requestedMarketplaceId || availableMarketplaces[0]?.name || ''
  const selectedId = availableMarketplaces.some(
    marketplace => marketplace.name === requestedSelectedId
  )
    ? requestedSelectedId
    : (availableMarketplaces[0]?.name ?? '')
  const selectedMarketplaces = params.mergeAllMarketplaces
    ? availableMarketplaces
    : filteredMarketplaces(availableMarketplaces, selectedId)
  const personalMarketplace = availableMarketplaces.find(
    marketplace =>
      marketplace.name === WEWORK_PERSONAL_MARKETPLACE_ID &&
      marketplace.path &&
      isLocalMarketplacePath(marketplace.path)
  )
  const cloudLinks = personalMarketplace?.path
    ? await readLocalPluginCloudLinks(personalMarketplace.path).catch(
        () => [] as LocalPluginCloudLink[]
      )
    : []
  const availableMarketplaceItems = selectedMarketplaces.flatMap(marketplace =>
    marketplace.plugins.map(plugin => toMarketplaceItem(marketplace, plugin, null, featuredIds))
  )
  // plugin/installed is authoritative for membership. Fold in the device store
  // inventory from the same live read, but never revive rows from an older cache.
  const installedPlugins = mergeLocalInstalledWithStorePackages(
    applyPluginCloudLinks(
      preferWeworkPersonalInstalled(
        mergeInstalledPluginSummaries(installedResponse.marketplaces, availableMarketplaces)
      ),
      cloudLinks
    ),
    await storePluginsPromise
  )
  const marketplaceItems = applyInstalledPluginsToMarketplaceItems(
    availableMarketplaceItems,
    installedPlugins
  )
  const marketplaces = availableMarketplaces.map(marketplaceInfo)
  const loadedState: LocalCodexPluginsState = {
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
  const state = retainOpenAiOfficialCatalog(
    cachedStateParamsKey === paramsKey ? cachedState : null,
    loadedState
  )
  if (generation < cachedStateGeneration && cachedStateParamsKey === paramsKey && cachedState) {
    return cachedState
  }
  if (generation >= cachedStateGeneration) {
    // Always cache the unfiltered catalog so search queries can reuse it.
    rememberReadStateSnapshot(paramsKey, state, generation)
    rememberSelectedMarketplaceId(selectedId)
  }
  if (!params.skipPersonalReconcile) {
    const migrated = await reconcileCodexPersonalPlugins(state)
    if (migrated) {
      return loadReadStateSnapshot(
        { ...params, skipPersonalReconcile: true, refresh: true },
        paramsKey
      )
    }
  }
  return state
}

function marketplaceEntryFromInstalledPlugin(plugin: InstalledPlugin): CodexPluginMarketplaceEntry {
  const payload =
    plugin.spec.sourcePayload && typeof plugin.spec.sourcePayload === 'object'
      ? (plugin.spec.sourcePayload as Record<string, unknown>)
      : null
  const marketplaceName =
    (typeof payload?.marketplaceName === 'string' && payload.marketplaceName.trim()) ||
    (typeof plugin.metadata.namespace === 'string' && plugin.metadata.namespace.trim()) ||
    (typeof plugin.spec.source.marketplace === 'string' && plugin.spec.source.marketplace.trim()) ||
    plugin.spec.source.providerKey ||
    ''
  const marketplacePath =
    (typeof payload?.marketplacePath === 'string' && payload.marketplacePath.trim()) ||
    marketplaceName
  return {
    name: marketplaceName,
    path: marketplacePath,
    interface: {
      displayName: marketplaceName,
    },
    plugins: [],
  }
}

function pluginNameFromInstalledPlugin(plugin: InstalledPlugin): string {
  const payload =
    plugin.spec.sourcePayload && typeof plugin.spec.sourcePayload === 'object'
      ? (plugin.spec.sourcePayload as Record<string, unknown>)
      : null
  if (typeof payload?.pluginName === 'string' && payload.pluginName.trim()) {
    return payload.pluginName.trim()
  }
  if (plugin.spec.source.pluginKey.trim()) return plugin.spec.source.pluginKey.trim()
  return typeof plugin.metadata.name === 'string' ? plugin.metadata.name.trim() : ''
}

function marketplaceMetaForPluginRead(marketplaceId: string): LocalCodexMarketplace {
  const peeked =
    cachedState ??
    peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true }) ??
    peekLocalCodexPluginsReadState()
  const existing = peeked?.marketplaces.find(entry => entry.id === marketplaceId)
  return {
    id: marketplaceId,
    name: existing?.name?.trim() || marketplaceId,
    path: existing?.path?.trim() || marketplaceId,
  }
}

function rememberInstalledPluginDetail(detailed: InstalledPlugin): void {
  if (!cachedState) return
  const detailedId = String(installedPluginId(detailed) ?? '')
  const detailedKey = detailed.spec.source.pluginKey.trim().toLowerCase()
  const detailedMarketplace =
    (
      (typeof detailed.spec.sourcePayload?.marketplaceName === 'string' &&
        detailed.spec.sourcePayload.marketplaceName.trim()) ||
      detailed.spec.source.marketplace ||
      detailed.spec.source.providerKey ||
      ''
    ).trim() || ''
  let changed = false
  const installedPlugins = cachedState.installedPlugins.map(plugin => {
    const sameId = detailedId.length > 0 && String(installedPluginId(plugin) ?? '') === detailedId
    const sameKey =
      !sameId &&
      detailedKey.length > 0 &&
      plugin.spec.source.pluginKey.trim().toLowerCase() === detailedKey
    if (!sameId && !sameKey) return plugin
    changed = true
    return detailed
  })
  const marketplaceItems = cachedState.marketplaceItems.map(item => {
    if (item.name.trim().toLowerCase() !== detailedKey) return item
    const itemMarketplace =
      typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId.trim() : ''
    if (
      detailedMarketplace &&
      itemMarketplace &&
      itemMarketplace.toLowerCase() !== detailedMarketplace.toLowerCase()
    ) {
      return item
    }
    changed = true
    return {
      ...item,
      components: detailed.spec.components,
      interface: detailed.spec.interface ?? item.interface,
      description: detailed.spec.description || item.description,
    }
  })
  if (!changed) return
  cachedState = { ...cachedState, installedPlugins, marketplaceItems }
  cachedStateAt = Date.now()
  if (cachedStateParamsKey) {
    persistReadStateSnapshot(cachedStateParamsKey, cachedState, cachedStateAt)
  }
}

/**
 * Expand one installed membership summary with `plugin/read` (+ local manifest
 * connectors). Does not call `plugin/list` / full marketplace `readState`.
 */
async function readDetailForInstalledPlugin(plugin: InstalledPlugin): Promise<InstalledPlugin> {
  const marketplace = marketplaceEntryFromInstalledPlugin(plugin)
  const pluginName = pluginNameFromInstalledPlugin(plugin)
  const payload =
    plugin.spec.sourcePayload && typeof plugin.spec.sourcePayload === 'object'
      ? (plugin.spec.sourcePayload as Record<string, unknown>)
      : null
  const id = installedPluginId(plugin) ?? pluginName
  const detail = await readPluginDetail(
    {
      id: marketplace.name,
      name: marketplace.name,
      path: marketplace.path ?? marketplace.name,
    },
    pluginName
  )
  const detailed = toInstalledPlugin(
    marketplace,
    {
      id: String(id),
      remotePluginId:
        typeof payload?.remotePluginId === 'string' ? payload.remotePluginId : String(id),
      localVersion: plugin.spec.version ?? null,
      name: pluginName,
      source:
        plugin.spec.manifest && typeof plugin.spec.manifest === 'object'
          ? (plugin.spec.manifest.source as Record<string, unknown> | undefined)
          : undefined,
      installed: true,
      enabled: plugin.spec.enabled,
      installPolicy:
        typeof plugin.spec.manifest?.installPolicy === 'string'
          ? plugin.spec.manifest.installPolicy
          : undefined,
      authPolicy:
        typeof plugin.spec.manifest?.authPolicy === 'string'
          ? plugin.spec.manifest.authPolicy
          : undefined,
      availability:
        typeof plugin.spec.manifest?.availability === 'string'
          ? plugin.spec.manifest.availability
          : undefined,
      interface: plugin.spec.interface ?? null,
      keywords: [],
    },
    detail
  )
  // Write connector/localAuth stubs back into the durable peek so the next send
  // can skip plugin/read (v1 durable cache always emptied components).
  rememberInstalledPluginDetail(detailed)
  return detailed
}

async function loadInstalledPluginsOnly(options: { shareInflight?: boolean } = {}): Promise<{
  installedPlugins: InstalledPlugin[]
  deviceId: string
}> {
  const executorStatus = await ensureLocalExecutorStarted()
  await ensureBundledPluginMarketplaceRegistered()
  const [installedResponse, storePlugins] = await Promise.all([
    requestPluginInstalled({ shareInflight: options.shareInflight }),
    listWegentStorePluginsFromDisk(),
  ])
  const bundled = getInitializedBundledPluginMarketplace()
  const personalPath =
    bundled?.path && isLocalMarketplacePath(bundled.path) ? bundled.path.trim() : ''
  const cloudLinks = personalPath
    ? await readLocalPluginCloudLinks(personalPath).catch(() => [] as LocalPluginCloudLink[])
    : []
  // Composer / auth gates only need membership. Never call plugin/list here — it
  // reconciles for ~10s and stalls Codex turns on the shared app-server.
  const installedPlugins = mergeLocalInstalledWithStorePackages(
    applyPluginCloudLinks(
      preferWeworkPersonalInstalled(
        mergeInstalledPluginSummaries(
          installedResponse.marketplaces,
          installedResponse.marketplaces
        )
      ),
      cloudLinks
    ),
    storePlugins
  )
  return {
    installedPlugins,
    deviceId: executorStatus.deviceId?.trim() ?? '',
  }
}

export function createLocalCodexPluginApi(): LocalCodexPluginApi {
  const defaultCodexLocalConfig: LocalCodexLocalConfig = {
    codexHome: '',
    configPath: '',
    remoteAppsEnabled: true,
  }
  return {
    async importExternalContent(source) {
      if (!isElectronRuntime()) {
        throw new Error('External content import requires the Wework desktop app')
      }
      const imported = await requestLocalExecutor<ExternalContentImportResult>(
        'executor.codex_home.import_external_content',
        { source }
      )
      clearLocalCodexPluginsReadStateCache()
      return imported
    },
    codexHomeMigrationStatus() {
      if (isElectronRuntime()) {
        return requestLocalExecutor<LocalCodexHomeMigrationStatus>('executor.codex_home.status')
      }
      return Promise.resolve({
        weworkCodexHome: '',
        nativeCodexHome: '',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: false,
        shouldPromptMigration: false,
      })
    },
    initializeCodexHome(options) {
      if (isElectronRuntime()) {
        return requestLocalExecutor<LocalCodexHomeMigrationStatus>(
          'executor.codex_home.initialize',
          {
            migrateNativeHome: options.migrateNativeHome,
            remoteAppsEnabled: options.remoteAppsEnabled ?? true,
          }
        )
      }
      return Promise.resolve({
        weworkCodexHome: '',
        nativeCodexHome: '',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: false,
        shouldPromptMigration: false,
      })
    },
    migrateNativeCodexHome(remoteAppsEnabled = true) {
      return this.initializeCodexHome({
        migrateNativeHome: true,
        remoteAppsEnabled,
      })
    },
    readCodexLocalConfig() {
      if (!isElectronRuntime()) {
        return Promise.resolve(defaultCodexLocalConfig)
      }
      return requestLocalExecutor<LocalCodexLocalConfig>('executor.codex_home.config.read')
    },
    updateCodexLocalConfig(patch) {
      if (!isElectronRuntime()) {
        return Promise.resolve({ ...defaultCodexLocalConfig, ...patch })
      }
      return requestLocalExecutor<LocalCodexLocalConfig>('executor.codex_home.config.update', {
        patch,
      })
    },
    async ensureCreatedPluginInWeworkPersonal(plugin) {
      if (!isElectronRuntime()) {
        throw new Error('Migrating a local plugin requires the Wework desktop app')
      }
      const sourcePayload = plugin.spec.sourcePayload ?? {}
      const pluginName =
        (typeof sourcePayload.pluginName === 'string' && sourcePayload.pluginName.trim()) ||
        plugin.spec.source.pluginKey
      if (!pluginName.trim()) {
        throw new Error('Local plugin name is unavailable')
      }
      let sourceMarketplacePath =
        typeof sourcePayload.marketplacePath === 'string'
          ? sourcePayload.marketplacePath.trim()
          : ''
      if (!sourceMarketplacePath) {
        const marketplaceName =
          (typeof sourcePayload.marketplaceName === 'string' && sourcePayload.marketplaceName) ||
          plugin.spec.source.marketplace ||
          plugin.spec.source.providerKey ||
          ''
        const state = cachedState ?? (await readState({ skipPersonalReconcile: true }))
        const marketplace = state.marketplaces.find(
          item => item.id === marketplaceName || item.name === marketplaceName
        )
        sourceMarketplacePath =
          marketplace && isLocalMarketplacePath(marketplace.path) ? marketplace.path : ''
      }
      if (!sourceMarketplacePath) {
        // Fall back to wework-personal itself when the plugin is already managed.
        sourceMarketplacePath = await resolveWeworkPersonalMarketplacePath()
      }
      try {
        return await ensurePluginInWeworkPersonal({
          sourceMarketplacePath,
          pluginName,
          installAfterMigrate: true,
        })
      } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to migrate local plugin'), {
          cause: error,
        })
      }
    },
    async packageCreatedPlugin(plugin) {
      if (!isElectronRuntime()) {
        throw new Error('Packaging a local plugin requires the Wework desktop app')
      }
      const ensured = await this.ensureCreatedPluginInWeworkPersonal(plugin)
      let artifact: LocalPluginPackageArtifact | null = null
      try {
        const response = await requestLocalExecutor<LocalPluginPackageArtifact>(
          'executor.plugins.personal.package',
          { marketplacePath: ensured.marketplacePath, pluginName: ensured.pluginName }
        )
        artifact = response
        const packaged = validateLocalPluginPackageArtifact(response)
        const bytes = await readElectronLocalFile(packaged.path, {
          expectedSize: packaged.size,
          maxBytes: MAX_PERSONAL_PLUGIN_PACKAGE_BYTES,
        })
        if (bytes.byteLength !== packaged.size) {
          throw new Error('Personal plugin package size did not match Executor metadata')
        }
        const sha256 = await sha256Hex(new Blob([bytes]))
        if (sha256 !== packaged.sha256) {
          throw new Error('Personal plugin package checksum did not match Executor metadata')
        }
        return new File([bytes], packaged.name, {
          type: 'application/zip',
        })
      } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to package local plugin'), {
          cause: error,
        })
      } finally {
        if (typeof artifact?.cleanupToken === 'string' && artifact.cleanupToken.trim()) {
          try {
            await requestLocalExecutor('executor.plugins.personal.package.cleanup', {
              cleanupToken: artifact.cleanupToken,
            })
          } catch (cleanupError) {
            console.warn('[Wework] Failed to clean up local plugin package artifact', cleanupError)
          }
        }
      }
    },
    async deletePersonalPlugin(pluginName, sourceMarketplacePath) {
      if (!isElectronRuntime()) {
        throw new Error('Deleting a personal plugin requires the Wework desktop app')
      }
      const marketplacePath =
        sourceMarketplacePath && isLocalMarketplacePath(sourceMarketplacePath)
          ? sourceMarketplacePath.trim()
          : await resolveWeworkPersonalMarketplacePath()
      try {
        await requestLocalExecutor('executor.plugins.personal.delete', {
          marketplacePath,
          pluginName,
        })
      } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to delete personal plugin'), {
          cause: error,
        })
      }
      clearLocalCodexPluginsReadStateCache()
    },
    async linkPersonalPluginRelease(plugin, cloudPluginId, cloudReleaseId) {
      if (!isElectronRuntime()) return
      const ensured = await this.ensureCreatedPluginInWeworkPersonal(plugin)
      try {
        await requestLocalExecutor('executor.plugins.links.link', {
          marketplacePath: ensured.marketplacePath,
          localPluginName: ensured.pluginName,
          cloudPluginId,
          cloudReleaseId,
        })
      } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to link local plugin release'), {
          cause: error,
        })
      }
      // Cloud link lives on disk; drop TTL cache so the next readState reloads links.
      clearLocalCodexPluginsReadStateCache()
    },
    async importMarketplaceCopy(descriptor) {
      if (!isElectronRuntime()) {
        throw new Error('Importing a plugin copy requires the Wework desktop app')
      }
      const currentState = cachedState ?? (await readState())
      const personalMarketplace = currentState.marketplaces.find(
        marketplace => marketplace.id === WEWORK_PERSONAL_MARKETPLACE_ID
      )
      if (!personalMarketplace || !isLocalMarketplacePath(personalMarketplace.path)) {
        throw new Error(`The ${WEWORK_PERSONAL_MARKETPLACE_ID} marketplace is unavailable`)
      }
      const imported = await requestLocalExecutor<LocalPluginCopyImportResult>(
        'executor.plugins.personal.import_copy',
        {
          marketplacePath: personalMarketplace.path,
          ...descriptor,
        }
      )
      clearLocalCodexPluginsReadStateCache()
      try {
        await codexAppServerRequest('plugin/install', {
          marketplacePath: personalMarketplace.path,
          remoteMarketplaceName: null,
          pluginName: imported.pluginName,
        })
      } catch (error) {
        await requestLocalExecutor('executor.plugins.personal.rollback_copy', {
          marketplacePath: personalMarketplace.path,
          pluginName: imported.pluginName,
        }).catch(() => undefined)
        clearLocalCodexPluginsReadStateCache()
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
    async previewPluginImport(archivePath) {
      if (!isElectronRuntime()) {
        throw new Error('Importing a plugin package requires the Wework desktop app')
      }
      const marketplacePath = await resolveWeworkPersonalMarketplacePath()
      return requestLocalExecutor<LocalPluginImportPreview>(
        'executor.plugins.import_package.preview',
        {
          archivePath,
          marketplacePath,
        }
      )
    },
    async importPluginPackage(preview, overwrite) {
      if (!isElectronRuntime()) {
        throw new Error('Importing a plugin package requires the Wework desktop app')
      }
      if (!preview.valid || !preview.name) {
        throw new Error('The selected plugin package did not pass validation')
      }
      const marketplacePath = await resolveWeworkPersonalMarketplacePath()
      const imported = await requestLocalExecutor<LocalPluginPackageImportResult>(
        'executor.plugins.import_package',
        {
          archivePath: preview.archivePath,
          marketplacePath,
          expectedSha256: preview.sha256,
          overwrite,
        }
      )
      clearLocalCodexPluginsReadStateCache()
      try {
        const commit = await requestLocalExecutor<LocalPluginInstallCommitResult>(
          'runtime.codex.plugin.install_local_first',
          {
            marketplacePath: codexMarketplaceManifestSource(marketplacePath),
            pluginName: imported.pluginName,
          }
        )
        if (!commit.localCommitted) {
          throw new Error('Plugin package did not reach its local installation commit')
        }
        await requestLocalExecutor('executor.plugins.import_package.finalize', {
          marketplacePath,
          rollbackId: imported.rollbackId,
        }).catch(error => {
          console.warn('[Wework] failed to clear plugin import backup', error)
        })
        return {
          pluginName: imported.pluginName,
          displayName: imported.displayName,
          version: imported.version,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const commitMayStillBeRunning =
          /local_plugin_commit_timeout/i.test(message) ||
          /runtime\.codex\.plugin\.install_local_first timed out/i.test(message)
        if (!commitMayStillBeRunning) {
          await requestLocalExecutor('executor.plugins.import_package.rollback', {
            marketplacePath,
            rollbackId: imported.rollbackId,
          }).catch(() => undefined)
        }
        clearLocalCodexPluginsReadStateCache()
        throw new Error(`Plugin package installation failed: ${message}`, { cause: error })
      }
    },
    savePluginExample(destinationPath) {
      if (!isElectronRuntime()) {
        throw new Error('Saving the plugin example requires the Wework desktop app')
      }
      return requestLocalExecutor<string>('executor.plugins.example.save', { destinationPath })
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
      if (!isDesktopRuntime()) {
        throw new Error('Reading local plugin detail requires the Wework desktop app')
      }
      const normalizedMarketplaceId = marketplaceId.trim()
      const normalizedPluginName = pluginName.trim()
      if (!normalizedMarketplaceId || !normalizedPluginName) {
        throw new Error('Marketplace id and plugin name are required')
      }
      // Never wait on plugin/list here. OpenAI catalog paint skips GitHub reconcile;
      // detail skills/apps come from plugin/read against the known marketplace id.
      const marketplaceMeta = marketplaceMetaForPluginRead(normalizedMarketplaceId)
      const detail = await readPluginDetail(marketplaceMeta, normalizedPluginName)
      const detailed = toInstalledPlugin(
        {
          name: marketplaceMeta.id,
          path: marketplaceMeta.path,
          interface: { displayName: marketplaceMeta.name },
          plugins: [],
        },
        detail.summary,
        detail
      )
      rememberInstalledPluginDetail(detailed)
      return detailed
    },
    async listInstalledPlugins(options) {
      if (!isDesktopRuntime()) return { items: [] }
      const mergeParams = { mergeAllMarketplaces: true as const }
      const peeked = peekLocalCodexPluginsReadState(mergeParams) || peekLocalCodexPluginsReadState()
      // Auto-sync / device inventory must bypass peek. Durable snapshots and a
      // fresh readState cache can both lag behind plugin/installed.
      if (!options?.refresh) {
        // Only trust a non-empty install list while the readState snapshot is still
        // fresh. Durable localStorage can keep installs for days after uninstall.
        const peekedIsFresh =
          Boolean(peeked) &&
          (isLocalCodexPluginsReadStateFresh(mergeParams) || isLocalCodexPluginsReadStateFresh())
        if (peeked && peeked.installedPlugins.length > 0 && peekedIsFresh) {
          return { items: peeked.installedPlugins, deviceId: peeked.deviceId }
        }
      }
      const loaded = await loadInstalledPluginsOnly({ shareInflight: options?.shareInflight })
      const installedPlugins = loaded.installedPlugins
      if (cachedState) {
        cachedState = {
          ...cachedState,
          installedPlugins,
          deviceId: loaded.deviceId || cachedState.deviceId,
        }
        cachedStateAt = Date.now()
        // Keep the update in memory only. Persisting would write a membership-only
        // snapshot into the 7-day durable cache and can clobber a fuller readState.
      }
      return { items: installedPlugins, deviceId: loaded.deviceId }
    },
    async listSkills(params = {}) {
      if (!isDesktopRuntime()) return []
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
      if (!isDesktopRuntime()) return []
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
      return apps.filter(
        app => app.isEnabled !== false && (params.includeInaccessible || app.isAccessible !== false)
      )
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
    rememberMarketplaceSelection(id) {
      rememberSelectedMarketplaceId(id)
    },
    async readInstalledPluginDetail(plugin) {
      return readDetailForInstalledPlugin(plugin)
    },
    async readInstalledPluginForTrial(id) {
      const findInstalled = (plugins: InstalledPlugin[]) =>
        plugins.find(plugin => matchesInstalledPluginTrialLookup(plugin, id))

      // Prefer membership-only sources. Chat/composer must never wait on
      // plugin/list (~10s) just to resolve connector localAuth for one plugin.
      const peeked =
        peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true }) ||
        peekLocalCodexPluginsReadState()
      let installed =
        (cachedState ? findInstalled(cachedState.installedPlugins) : null) ||
        (peeked ? findInstalled(peeked.installedPlugins) : null) ||
        null
      if (!installed) {
        const loaded = await loadInstalledPluginsOnly()
        installed = findInstalled(loaded.installedPlugins) ?? null
      }
      if (!installed) throw new Error('Codex plugin is not installed')
      return readDetailForInstalledPlugin(installed)
    },
    async deleteMarketplace(id) {
      await codexAppServerRequest('marketplace/remove', {
        marketplaceName: id,
      })
      if (selectedMarketplaceId() === id) rememberSelectedMarketplaceId('')
      clearLocalCodexPluginsReadStateCache()
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
      clearLocalCodexPluginsReadStateCache()
      return readState({ marketplaceId: response.marketplaceName, refresh: true })
    },
    async installAvailablePlugin(pluginId, marketplaceId) {
      const currentState = await readState({ mergeAllMarketplaces: true })
      const requestedMarketplaceId = marketplaceId?.trim()
      const item = currentState.marketplaceItems.find(
        item =>
          String(item.id) === String(pluginId) &&
          (!requestedMarketplaceId || item.manifest?.marketplaceId === requestedMarketplaceId)
      )
      if (!item) throw new Error('Codex plugin not found in current marketplace')
      const itemMarketplaceId =
        typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId.trim() : ''
      const resolvedMarketplaceId = requestedMarketplaceId || itemMarketplaceId
      if (!resolvedMarketplaceId) throw new Error('Codex plugin marketplace is missing')
      const marketplace = currentState.marketplaces.find(
        marketplace => marketplace.id === resolvedMarketplaceId
      )
      if (!marketplace) throw new Error('Codex plugin marketplace not found')
      const localMarketplace = isLocalMarketplacePath(marketplace.path)
      const installNames = localMarketplace
        ? [pluginInstallName(item, true)]
        : await resolveRemoteInstallPluginNames(marketplace, item)
      let installError: unknown = null
      for (let index = 0; index < installNames.length; index += 1) {
        const pluginName = installNames[index]
        try {
          await codexAppServerRequest('plugin/install', {
            marketplacePath: localMarketplace ? marketplace.path : null,
            remoteMarketplaceName: localMarketplace ? null : marketplace.id,
            pluginName,
          })
          installError = null
          break
        } catch (error) {
          installError = error
          const message = error instanceof Error ? error.message : String(error)
          const hasMore = index < installNames.length - 1
          if (!hasMore || !isRetriablePluginInstallCandidateError(message)) {
            throw error
          }
        }
      }
      if (installError) throw installError
      clearLocalCodexPluginsReadStateCache()
      const state = await readState({
        marketplaceId: resolvedMarketplaceId,
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
        const expectedMarketplaceName =
          typeof item.manifest?.marketplaceId === 'string'
            ? item.manifest.marketplaceId
            : marketplace.id
        return (
          plugin.spec.source.pluginKey === item.name &&
          (marketplaceName === expectedMarketplaceName ||
            (isPersonalMarketplaceId(marketplaceName) &&
              isPersonalMarketplaceId(expectedMarketplaceName)))
        )
      })
      if (!installed) throw new Error('Codex plugin installed but not returned by app-server')
      const detail = await readPluginDetail(marketplace, item.name)
      return {
        ...installed,
        spec: {
          ...installed.spec,
          components: pluginComponents(detail),
        },
      }
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
      clearLocalCodexPluginsReadStateCache()
      const state = await readState({ refresh: true })
      const installed = state.installedPlugins.find(
        plugin => String(installedPluginId(plugin)) === String(id)
      )
      if (!installed) throw new Error('Updated Codex plugin was not returned by app-server')
      return installed
    },
    async uninstallInstalledPlugin(id) {
      const requestedId = String(id)
      const localPersonalSuffix = `@${WEWORK_PERSONAL_MARKETPLACE_ID}`
      if (requestedId.endsWith(localPersonalSuffix)) {
        const pluginName = requestedId.slice(0, -localPersonalSuffix.length)
        if (pluginName) {
          const marketplacePath = await resolveWeworkPersonalMarketplacePath()
          await uninstallWeworkPersonalPluginLocally(pluginName, marketplacePath)
          return
        }
      }
      const currentState = cachedState ?? (await readState({ mergeAllMarketplaces: true }))
      const marketplaceItem = currentState.marketplaceItems.find(
        item =>
          String(item.id) === requestedId ||
          String(item.installedPluginId ?? '') === requestedId ||
          String(item.remotePluginId ?? '') === requestedId
      )
      const installed =
        currentState.installedPlugins.find(
          plugin => String(installedPluginId(plugin)) === requestedId
        ) ||
        (marketplaceItem
          ? currentState.installedPlugins.find(plugin => {
              const marketplaceName =
                plugin.spec.source.marketplace ||
                plugin.spec.source.providerKey ||
                (typeof plugin.spec.sourcePayload?.marketplaceName === 'string'
                  ? plugin.spec.sourcePayload.marketplaceName
                  : plugin.metadata.namespace)
              return (
                plugin.spec.source.pluginKey === marketplaceItem.name &&
                pluginMarketplaceIdentity(
                  marketplaceItem.name,
                  typeof marketplaceName === 'string' ? marketplaceName : ''
                ) ===
                  pluginMarketplaceIdentity(
                    marketplaceItem.name,
                    typeof marketplaceItem.manifest?.marketplaceId === 'string'
                      ? marketplaceItem.manifest.marketplaceId
                      : ''
                  )
              )
            })
          : undefined)
      const payload =
        installed?.spec.sourcePayload && typeof installed.spec.sourcePayload === 'object'
          ? (installed.spec.sourcePayload as Record<string, unknown>)
          : {}
      const marketplace =
        installed?.spec.source.marketplace ||
        installed?.spec.source.providerKey ||
        (typeof payload.marketplaceName === 'string' ? payload.marketplaceName : '') ||
        installed?.metadata.namespace ||
        (typeof marketplaceItem?.manifest?.marketplaceId === 'string'
          ? marketplaceItem.manifest.marketplaceId
          : '')
      const marketplaceName = typeof marketplace === 'string' ? marketplace : ''
      const pluginName =
        installed?.spec.source.pluginKey ||
        marketplaceItem?.name ||
        requestedId.split('@')[0] ||
        requestedId
      if (marketplaceName === WEWORK_PERSONAL_MARKETPLACE_ID) {
        const personalMarketplace = currentState.marketplaces.find(
          marketplace =>
            marketplace.id === WEWORK_PERSONAL_MARKETPLACE_ID &&
            marketplace.path &&
            isLocalMarketplacePath(marketplace.path)
        )
        if (!personalMarketplace?.path) {
          throw new Error('Wework personal marketplace path is unavailable')
        }
        await uninstallWeworkPersonalPluginLocally(String(pluginName), personalMarketplace.path)
        return
      }
      const remotePluginId =
        (typeof payload.remotePluginId === 'string' && payload.remotePluginId.trim()) ||
        (typeof installed?.spec.source.catalogItemId === 'string' &&
          installed.spec.source.catalogItemId.trim()) ||
        (typeof marketplaceItem?.remotePluginId === 'string' &&
          marketplaceItem.remotePluginId.trim()) ||
        ''
      const installedId = installed ? installedPluginId(installed) : null
      const pluginIds = [
        ...buildPluginUninstallCandidateIds({
          requestedId,
          pluginName: String(pluginName),
          marketplaceName,
          remotePluginId,
          marketplaceItemId: marketplaceItem ? String(marketplaceItem.id) : '',
          installedId:
            typeof installedId === 'string' || typeof installedId === 'number'
              ? String(installedId)
              : '',
        }),
        ...(isPersonalMarketplaceId(marketplaceName)
          ? [
              `${pluginName}@${CODEX_PERSONAL_MARKETPLACE_ID}`,
              `${pluginName}@${WEWORK_PERSONAL_MARKETPLACE_ID}`,
            ]
          : []),
      ].filter((value, index, all) => value && all.indexOf(value) === index)
      let uninstallAccepted = false
      let lastUninstallError: unknown = null
      for (const pluginId of pluginIds) {
        try {
          await codexAppServerRequest('plugin/uninstall', { pluginId })
          uninstallAccepted = true
        } catch (error) {
          lastUninstallError = error
          if (
            isRetriablePluginUninstallCandidateError(
              getErrorMessage(error, 'Plugin uninstall failed')
            )
          ) {
            continue
          }
          if (!uninstallAccepted) throw error
          // A previous candidate already uninstalled; alias cleanup must not look
          // like a hard fail.
          throw new LocalPluginUninstallCleanupError(
            getErrorMessage(error, 'Failed to uninstall plugin alias'),
            { cause: error }
          )
        }
      }
      if (!uninstallAccepted) {
        throw lastUninstallError instanceof Error
          ? lastUninstallError
          : new Error(
              getErrorMessage(lastUninstallError, 'Plugin uninstall failed') ||
                `Failed to uninstall plugin; tried ids: ${pluginIds.join(', ')}`
            )
      }
      clearLocalCodexPluginsReadStateCache()
      if (isPersonalMarketplaceId(marketplaceName)) {
        const personalMarketplace = currentState.marketplaces.find(
          marketplace =>
            marketplace.id === WEWORK_PERSONAL_MARKETPLACE_ID &&
            marketplace.path &&
            isLocalMarketplacePath(marketplace.path)
        )
        if (personalMarketplace?.path) {
          try {
            await unlinkLocalPluginRelease(personalMarketplace.path, String(pluginName))
          } catch (error) {
            throw new LocalPluginUninstallCleanupError(
              getErrorMessage(error, 'Failed to unlink local plugin release'),
              { cause: error }
            )
          }
        }
      }
      const after = await readState({ mergeAllMarketplaces: true, refresh: true })
      const stillInstalled =
        after.installedPlugins.some(plugin => {
          if (plugin.spec.installState !== 'installed') return false
          const marketplace =
            plugin.spec.source.marketplace ||
            plugin.spec.source.providerKey ||
            (typeof plugin.spec.sourcePayload?.marketplaceName === 'string'
              ? plugin.spec.sourcePayload.marketplaceName
              : plugin.metadata.namespace)
          return (
            plugin.spec.source.pluginKey === pluginName &&
            (!marketplaceName ||
              pluginMarketplaceIdentity(pluginName, String(marketplace || '')) ===
                pluginMarketplaceIdentity(pluginName, marketplaceName))
          )
        }) ||
        after.marketplaceItems.some(
          item =>
            item.installed &&
            item.name === pluginName &&
            (!marketplaceName ||
              pluginMarketplaceIdentity(
                item.name,
                typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId : ''
              ) === pluginMarketplaceIdentity(pluginName, marketplaceName))
        )
      if (stillInstalled) {
        throw new Error(
          `Plugin "${pluginName}" is still installed after uninstall; tried ids: ${pluginIds.join(', ')}`
        )
      }
    },
  }
}
