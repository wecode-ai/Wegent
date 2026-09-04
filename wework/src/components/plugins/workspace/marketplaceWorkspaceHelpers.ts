import { createHttpClient } from '@/api/http'
import {
  peekLocalCodexPluginsReadState,
  type LocalCodexMarketplace,
} from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { getRuntimeConfig } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import {
  isBuiltInMarketplaceId,
  isOpenAiOfficialMarketplaceId,
} from '@/features/plugins/marketplaceIdentity'
import { marketplaceNameForVisibility } from '@/features/plugins/pluginMarketplaceIdentity'
import { queuePluginPromptTrial, queuePluginTrial } from '@/features/plugins/pluginTrial'
import type { PluginMarketplaceCacheSnapshot } from '@/features/plugins/pluginMarketplaceCache'
import type { InstalledPlugin, PluginAccessResponse, PluginMarketplaceItem } from '@/types/api'
import { connectorDisplayName } from '../connectorDisplayName'
import { formatPluginVersion } from '../plugin-display'
import { resolvePluginLogo } from '../plugin-assets'
import {
  installedPluginSourceLabel,
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
  storeDirMatchesPluginKey,
} from '../installedPluginMerge'
import { isLocalMarketplaceItem, mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'
import { installedPluginDistribution, marketplaceItemMarketplaceId } from '../pluginDistribution'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { sharedRecipientMetaItems } from '../pluginManagementSubtitle'

export type MarketplaceKind = 'local' | 'cloud'

export interface MarketplaceOption {
  key: string
  id: string
  name: string
  kind: MarketplaceKind
  path?: string
}

export interface AddMarketFormData {
  source: string
  gitRef: string
  subPath: string
}

export interface PluginMarketplaceState {
  items: PluginMarketplaceItem[]
  isLoading: boolean
  error: string | null
}

export interface PluginShareState {
  plugin: PluginMarketplaceItem
  access: PluginAccessResponse
}

export const CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS = 60_000
export const INSTALLED_STRIP_VISIBLE_COUNT = 12
export const INSTALLED_STRIP_OVERFLOW_PREVIEW_COUNT = 4
export const MARKETPLACE_SEARCH_RESULT_BATCH_SIZE = 40
export const MARKETPLACE_SECTION_PREVIEW_COUNT = 4
const SELECTED_MARKETPLACE_KEY_STORAGE = 'wework.plugins.selectedMarketplaceKey'

export function marketplaceSectionRevealLabel(
  hiddenItems: PluginMarketplaceItem[],
  t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string
): string {
  const names = hiddenItems
    .slice(0, 2)
    .map(item => item.displayName || item.name)
    .join(', ')
  if (hiddenItems.length > 2) {
    return t('workbench.plugins_view_more_with_count', '查看 {{names}}，以及另外 {{count}} 个', {
      names,
      count: hiddenItems.length - 2,
    })
  }
  return t('workbench.plugins_view_more', '查看 {{names}}', { names })
}

export function toInstalledPluginItem(item: InstalledPlugin): InstalledPluginItem {
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

export function toMarketplaceInstalledPluginItem(item: PluginMarketplaceItem): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: item.name,
      namespace: 'marketplace',
      labels: { id: item.id },
    },
    spec: {
      source: {
        type: item.sourceType,
        providerKey: 'marketplace',
        pluginKey: item.name,
        catalogItemId: item.remotePluginId,
      },
      origin: 'market',
      pluginId: Number(item.id),
      releaseId: item.latestReleaseId ?? null,
      desiredVersion: item.version ?? null,
      updatePolicy: 'manual',
      sourceProvider: item.sourceProvider,
      sourceLabel: item.sourceLabel,
      visibility: item.visibility,
      displayName: item.displayName || item.name,
      description: item.description,
      version: item.version,
      author: item.author,
      installState:
        item.currentDeviceInstallation?.state === 'failed'
          ? 'failed'
          : item.installed
            ? 'installed'
            : 'not_installed',
      enabled: item.enabled,
      componentStates: {},
      manifest: item.manifest ?? {},
      components: item.components,
      interface: item.interface,
      packageRef: null,
      sourcePayload: {
        marketplaceName:
          marketplaceItemMarketplaceId(item) ||
          marketplaceNameForVisibility(item.visibility) ||
          'default',
        pluginName: item.name,
        remotePluginId: item.remotePluginId,
      },
    },
    status: {
      state: item.installed ? 'enabled' : item.currentDeviceInstallation?.state || 'available',
      devices: item.currentDeviceInstallation ? [item.currentDeviceInstallation] : [],
    },
  }
  return toInstalledPluginItem(raw)
}

function pickRenderableLogoField(
  primary?: string | null,
  secondary?: string | null
): string | null | undefined {
  if (
    primary &&
    resolvePluginLogo({ logo: primary, appearanceMode: 'light' }).source === 'provided'
  ) {
    return primary
  }
  if (
    secondary &&
    resolvePluginLogo({ logo: secondary, appearanceMode: 'light' }).source === 'provided'
  ) {
    return secondary
  }
  return primary || secondary
}

export function withMarketplaceListingInterface(
  installed: InstalledPluginItem,
  marketplaceItem: PluginMarketplaceItem
): InstalledPluginItem {
  const version = installed.version || marketplaceItem.version
  const installedInterface = installed.raw.spec.interface
  const marketInterface = marketplaceItem.interface
  const mergedInterface =
    installedInterface || marketInterface
      ? {
          ...(marketInterface ?? {}),
          ...(installedInterface ?? {}),
          logo: pickRenderableLogoField(installedInterface?.logo, marketInterface?.logo),
          logoDark: pickRenderableLogoField(
            installedInterface?.logoDark,
            marketInterface?.logoDark
          ),
          composerIcon: pickRenderableLogoField(
            installedInterface?.composerIcon,
            marketInterface?.composerIcon
          ),
        }
      : null
  return {
    ...installed,
    version,
    raw: {
      ...installed.raw,
      spec: {
        ...installed.raw.spec,
        interface: mergedInterface,
        version,
      },
    },
  }
}

export function withMarketplacePluginDetail(
  plugin: InstalledPluginItem,
  detail: InstalledPlugin
): InstalledPluginItem {
  return {
    ...plugin,
    raw: {
      ...plugin.raw,
      spec: {
        ...plugin.raw.spec,
        components: detail.spec.components,
        componentStates: detail.spec.componentStates || plugin.raw.spec.componentStates,
        description: detail.spec.description || plugin.raw.spec.description,
        interface: {
          ...plugin.raw.spec.interface,
          ...detail.spec.interface,
        },
      },
    },
  }
}

export function pluginDetailHasVisibleComponents(plugin: InstalledPluginItem): boolean {
  const components = plugin.raw.spec.components
  return (
    components.skills.length > 0 ||
    components.commands.length > 0 ||
    (components.apps?.length ?? 0) > 0 ||
    components.agents.length > 0 ||
    components.mcps.length > 0 ||
    components.hooks.length > 0 ||
    (components.connectors?.length ?? 0) > 0
  )
}

export function keepRicherMarketplacePluginDetail(
  previous: InstalledPluginItem | null,
  next: InstalledPluginItem
): InstalledPluginItem {
  if (
    previous &&
    previous.raw.spec.source.pluginKey === next.raw.spec.source.pluginKey &&
    pluginDetailHasVisibleComponents(previous) &&
    !pluginDetailHasVisibleComponents(next)
  ) {
    return {
      ...next,
      raw: {
        ...next.raw,
        spec: {
          ...next.raw.spec,
          components: previous.raw.spec.components,
          componentStates: previous.raw.spec.componentStates || next.raw.spec.componentStates,
        },
      },
    }
  }
  return next
}

export function createDefaultPluginApi(apiBaseUrl?: string, token?: string | null) {
  const runtime = getRuntimeConfig()
  const resolvedApiBaseUrl = apiBaseUrl || runtime.apiBaseUrl
  return createPluginApi(
    createHttpClient({
      baseUrl: resolvedApiBaseUrl,
      ...(token === undefined
        ? {}
        : {
            getToken: () => token,
            redirectOnUnauthorized: false,
          }),
    }),
    resolvedApiBaseUrl
  )
}

export function marketplaceComponentCount(item: PluginMarketplaceItem): number {
  const components = item.components
  return (
    components.skills.length +
    components.commands.length +
    (components.apps?.length ?? 0) +
    components.agents.length +
    components.mcps.length +
    components.hooks.length
  )
}

export function withMarketplaceDetailComponents(
  item: PluginMarketplaceItem,
  detail: InstalledPluginItem | null
): PluginMarketplaceItem {
  if (!detail) return item
  return {
    ...item,
    components: detail.raw.spec.components,
  }
}

export function requiredConnectionNames(item: PluginMarketplaceItem): string[] {
  const pluginName = item.displayName || item.name
  return (item.components.connectors ?? [])
    .filter(connector => connector.authPolicy === 'on_install')
    .map(connector => connectorDisplayName(connector.slug, { pluginName }))
}

export function marketplaceRowMetaItems(
  item: PluginMarketplaceItem,
  t: (key: string, fallback: string) => string
): string[] {
  if (item.accessRole === 'recipient') {
    return sharedRecipientMetaItems(item, t)
  }
  if (item.accessRole === 'owner' && item.visibility === 'personal') {
    const meta = [t('workbench.plugins_personal_created', '个人创建')]
    if (item.version) meta.push(`v${formatPluginVersion(item.version)}`)
    return meta
  }
  const publisher = (item.author || item.sourceLabel || item.sourceProvider || '').trim()
  const meta = publisher ? [publisher] : []
  if (item.version) meta.push(`v${formatPluginVersion(item.version)}`)
  return meta
}

export function tryPluginInChat(plugin: InstalledPlugin): boolean {
  const queued = queuePluginTrial(plugin, { openInNewChat: true })
  if (queued) navigateTo('/')
  return queued
}

/**
 * Start a plugin trial from catalog/installed rows already on screen.
 * Do not wait on Codex plugin/read or GitHub plugin/list — OpenAI official
 * plugins already have name, marketplace, and prompts in the detail payload.
 */
export function queueMarketplacePluginTrial(options: {
  item: PluginMarketplaceItem
  installed?: InstalledPluginItem | null
  prompt?: string
  rememberMarketplaceSelection?: (marketplaceId: string) => void
}): boolean {
  const marketplaceId = localMarketplaceIdFromItem(options.item)
  if (marketplaceId) options.rememberMarketplaceSelection?.(marketplaceId)
  const trialPlugin = (options.installed ?? toMarketplaceInstalledPluginItem(options.item)).raw
  if (options.prompt) {
    const queued = queuePluginPromptTrial(trialPlugin, options.prompt, { openInNewChat: true })
    if (queued) navigateTo('/')
    return queued
  }
  return tryPluginInChat(trialPlugin)
}

export function findInstalledPluginForMarketplaceItem(
  item: PluginMarketplaceItem,
  plugins: InstalledPluginItem[]
): InstalledPluginItem | null {
  if (item.installedPluginId !== null && item.installedPluginId !== undefined) {
    const byInstalledId = plugins.find(
      plugin => String(plugin.id) === String(item.installedPluginId)
    )
    if (byInstalledId) return byInstalledId
  }
  const marketplaceId = marketplaceItemMarketplaceId(item)
  const pluginKey = item.name.trim().toLowerCase()
  if (!pluginKey) return null
  const byIdentity =
    plugins.find(plugin => {
      const rawKey = plugin.raw.spec.source.pluginKey.trim().toLowerCase()
      if (rawKey !== pluginKey) return false
      if (!marketplaceId) return true
      const payload = plugin.raw.spec.sourcePayload
      const payloadMarketplace =
        payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>).marketplaceName
          : null
      const candidates = [
        payloadMarketplace,
        plugin.raw.spec.source.marketplace,
        plugin.raw.spec.source.providerKey,
        plugin.raw.metadata.namespace,
      ]
      return candidates.some(
        candidate => typeof candidate === 'string' && candidate.trim() === marketplaceId
      )
    }) ?? null
  if (byIdentity) return byIdentity
  return (
    plugins.find(
      plugin =>
        storeDirMatchesPluginKey(String(plugin.id), item.name) ||
        storeDirMatchesPluginKey(String(plugin.raw.metadata.name || ''), item.name) ||
        storeDirMatchesPluginKey(String(plugin.raw.spec.source.pluginKey || ''), item.name)
    ) ?? null
  )
}

export function localMarketplaceKey(id: string): string {
  return `local:${id}`
}

export function cloudMarketplaceKey(): string {
  return 'cloud:default'
}

export function isUserAddedMarketplace(marketplace: MarketplaceOption): boolean {
  return marketplace.kind === 'local' && !isBuiltInMarketplaceId(marketplace.id)
}

export function localMarketplaceIdFromItem(item: PluginMarketplaceItem): string | null {
  return marketplaceItemMarketplaceId(item)
}

export function isMarketplaceSourceValid(value: string): boolean {
  const source = value.trim()
  return (
    /^[\w.-]+\/[\w.-]+$/.test(source) ||
    /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/i.test(source) ||
    /^(\/|\.{1,2}\/|~\/)[^\0]+$/.test(source) ||
    /^[a-zA-Z]:[\\/][^\0]+$/.test(source)
  )
}

export function rememberedMarketplaceKey(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(SELECTED_MARKETPLACE_KEY_STORAGE) ?? ''
}

export function rememberMarketplaceKey(key: string): void {
  if (typeof window === 'undefined') return
  if (key) {
    window.localStorage.setItem(SELECTED_MARKETPLACE_KEY_STORAGE, key)
  } else {
    window.localStorage.removeItem(SELECTED_MARKETPLACE_KEY_STORAGE)
  }
}

export function currentDeviceInstallation(
  plugin: InstalledPlugin,
  deviceId: string
): NonNullable<PluginMarketplaceItem['currentDeviceInstallation']> | null {
  return plugin.status.devices?.find(device => device.deviceId === deviceId) ?? null
}

export function toMarketplaceOptions(
  localMarketplaces: LocalCodexMarketplace[],
  cloudAvailable: boolean,
  cloudMarketplaceName: string
): MarketplaceOption[] {
  const cloudOptions: MarketplaceOption[] = cloudAvailable
    ? [
        {
          key: cloudMarketplaceKey(),
          id: 'default',
          name: cloudMarketplaceName,
          kind: 'cloud',
        },
      ]
    : []
  const localOptions: MarketplaceOption[] = localMarketplaces.map(marketplace => ({
    key: localMarketplaceKey(marketplace.id),
    id: marketplace.id,
    name: marketplace.name,
    kind: 'local' as const,
    path: marketplace.path,
  }))
  return [...cloudOptions, ...localOptions]
}

export function isCodexCatalogItem(item: PluginMarketplaceItem): boolean {
  if (isLocalMarketplaceItem(item)) return true
  const marketplaceId = marketplaceItemMarketplaceId(item)
  return marketplaceId != null && isOpenAiOfficialMarketplaceId(marketplaceId)
}

export function pluginUsesWegentConnectorOAuth(
  plugin?: InstalledPluginItem | PluginMarketplaceItem | null
): boolean {
  // OpenAI/personal connectors authorize in chat. Wegent cloud plugins use
  // connector-apps OAuth. Missing plugin data stays on the host OAuth path.
  if (!plugin) return true
  if ('raw' in plugin) {
    if (typeof plugin.raw.spec.pluginId === 'number') return true
    const namespace =
      typeof plugin.raw.metadata.namespace === 'string' ? plugin.raw.metadata.namespace : ''
    const marketplace =
      plugin.raw.spec.source.marketplace || namespace || plugin.raw.spec.source.providerKey || ''
    if (isOpenAiOfficialMarketplaceId(marketplace) || isPersonalMarketplaceId(marketplace)) {
      return false
    }
    return plugin.raw.spec.sourceProvider !== 'codex'
  }
  return !isCodexCatalogItem(plugin)
}

export function pluginDetailActionErrorMessage(
  error: { pluginId: string | number; message: string } | null,
  pluginId: string | number | null | undefined
): string | null {
  if (!error || pluginId == null || String(pluginId).length === 0) return null
  return String(error.pluginId) === String(pluginId) ? error.message : null
}

export function preferNonEmptyCatalogRows(
  incoming: PluginMarketplaceItem[] | null | undefined,
  fallback: PluginMarketplaceItem[]
): PluginMarketplaceItem[] {
  return incoming && incoming.length > 0 ? incoming : fallback
}

export function nonCodexCatalogItems(items: PluginMarketplaceItem[]): PluginMarketplaceItem[] {
  return items.filter(item => !isCodexCatalogItem(item))
}

export function mergeWarmMarketplaceItems(
  cached: PluginMarketplaceCacheSnapshot | null,
  durablePeek: Awaited<ReturnType<typeof peekLocalCodexPluginsReadState>>
): PluginMarketplaceItem[] {
  const cachedItems = cached?.marketplaceItems ?? []
  const cachedLocalItems = cachedItems.filter(isCodexCatalogItem)
  const localItemsById = new Map(cachedLocalItems.map(item => [String(item.id), item] as const))
  for (const item of durablePeek?.marketplaceItems ?? []) {
    localItemsById.set(String(item.id), item)
  }
  return mergeMarketplaceCatalog(
    cachedItems.filter(item => !isCodexCatalogItem(item)),
    [...localItemsById.values()],
    (cached?.installedPlugins ?? []).map(plugin => plugin.raw)
  )
}

export function hasOpenAiOfficialCatalog(items: PluginMarketplaceItem[]): boolean {
  return items.some(item => {
    const marketplaceId = marketplaceItemMarketplaceId(item)
    return marketplaceId != null && isOpenAiOfficialMarketplaceId(marketplaceId)
  })
}

function durableLocalStateMatchesCachedDevice(
  cached: PluginMarketplaceCacheSnapshot | null,
  durablePeek: Awaited<ReturnType<typeof peekLocalCodexPluginsReadState>>
): boolean {
  const localDeviceId = durablePeek?.deviceId.trim() || ''
  if (!localDeviceId) return false
  const cachedDeviceId = cached?.deviceId.trim() || ''
  return !cachedDeviceId || cachedDeviceId === localDeviceId
}

export function mergeWarmInstalledPlugins(
  cached: PluginMarketplaceCacheSnapshot | null,
  durablePeek: Awaited<ReturnType<typeof peekLocalCodexPluginsReadState>>
): InstalledPluginItem[] {
  const cachedRaw = (cached?.installedPlugins ?? []).map(plugin => plugin.raw)
  if (!durablePeek || !durableLocalStateMatchesCachedDevice(cached, durablePeek)) {
    return cached?.installedPlugins ?? []
  }
  const cloudRaw = cachedRaw.filter(isCloudManagedInstalledPlugin)
  return mergeInstalledPlugins(cloudRaw, durablePeek.installedPlugins, durablePeek.deviceId).map(
    toInstalledPluginItem
  )
}

export function mergeWarmMarketplaceOptions(
  cached: PluginMarketplaceCacheSnapshot | null,
  durablePeek: Awaited<ReturnType<typeof peekLocalCodexPluginsReadState>>,
  cloudAvailable: boolean,
  cloudMarketplaceName: string
): MarketplaceOption[] {
  const optionsByKey = new Map(
    (cached?.marketplaces ?? []).map(option => [option.key, option] as const)
  )
  for (const option of toMarketplaceOptions(
    durablePeek?.marketplaces ?? [],
    cloudAvailable,
    cloudMarketplaceName
  )) {
    optionsByKey.set(option.key, option)
  }
  return [...optionsByKey.values()]
}
