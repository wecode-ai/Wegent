import { applyScopedPluginVisibility } from '@wegent/chat-core/composer-plugin-scope'
import {
  appendInstalledPluginsAsComposerApps,
  enrichComposerApps,
} from '@wegent/chat-core/composer-plugin-metadata'
import { mergeInstalledPlugins } from '@wegent/chat-core/installed-plugin-merge'
import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import { pluginPresentation, overlayMarketplaceLogosOnComposerApps } from './composerPluginMetadata'
import {
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
  type PluginMarketplaceCacheSnapshot,
} from './pluginMarketplaceCache'
import { publishPluginInvocationCatalog } from './pluginInvocationTelemetry'
import { installedPluginHasRelativeLogo } from '@/components/plugins/plugin-assets'

/** Detail reads may enrich surviving records, but never restore removed packages. */
export async function hydratePluginInventoryLogos(
  cacheKey: string,
  snapshot: PluginMarketplaceCacheSnapshot,
  readDetail: (plugin: InstalledPlugin) => Promise<InstalledPlugin>,
  isCurrent: () => boolean
): Promise<void> {
  const candidates = snapshot.installedPlugins.filter(installedPluginHasRelativeLogo)
  if (!candidates.length) return
  const details = await Promise.all(candidates.map(plugin => readDetail(plugin)))
  if (!isCurrent()) return
  const current = getPluginMarketplaceCache(cacheKey)
  if (!current || current.deviceId !== snapshot.deviceId) return
  const updates = new Map(candidates.map((plugin, index) => [plugin, details[index]]))
  const installedPlugins = current.installedPlugins.map(plugin => {
    const detail = updates.get(plugin)
    return detail
      ? {
          ...plugin,
          spec: {
            ...plugin.spec,
            interface: detail.spec.interface,
            components: detail.spec.components,
          },
        }
      : plugin
  })
  if (installedPlugins.every((plugin, index) => plugin === current.installedPlugins[index])) return
  writePluginInventory(cacheKey, snapshot.deviceId, { installedPlugins })
}

/** Views only project the shared domain snapshot; they never merge transport responses. */
export function selectComposerPluginApps(
  snapshot: PluginMarketplaceCacheSnapshot,
  visiblePluginKeys?: ReadonlySet<string>
): LocalDeviceApp[] {
  const installed = applyScopedPluginVisibility(snapshot.installedPlugins, visiblePluginKeys)
  const presentation = (plugin: InstalledPlugin) =>
    pluginPresentation(plugin, snapshot.marketplaceItems)
  const apps = appendInstalledPluginsAsComposerApps(
    enrichComposerApps(snapshot.apps ?? [], installed, presentation),
    installed,
    presentation
  )
  const ids = new Set(apps.map(app => app.id))
  return overlayMarketplaceLogosOnComposerApps(
    [...apps, ...(snapshot.connectorApps ?? []).filter(app => !ids.has(app.id))],
    snapshot.marketplaceItems
  )
}

export function writePluginInventory(
  cacheKey: string,
  deviceId: string,
  update: Pick<
    Partial<PluginMarketplaceCacheSnapshot>,
    'installedPlugins' | 'installedPluginsFetchedAt' | 'apps' | 'connectorApps' | 'marketplaceItems'
  >,
  options?: { mutation?: boolean }
): PluginMarketplaceCacheSnapshot {
  const cached = getPluginMarketplaceCache(cacheKey)
  const previous = cached?.deviceId === deviceId ? cached : null
  const catalog = cached && !cached.deviceId ? cached : previous
  const next: PluginMarketplaceCacheSnapshot = {
    cacheKey,
    deviceId,
    marketplaceItems: catalog?.marketplaceItems ?? [],
    marketplaces: catalog?.marketplaces ?? [],
    selectedMarketplaceKey: catalog?.selectedMarketplaceKey ?? '',
    installedPlugins: previous?.installedPlugins ?? [],
    apps: previous?.apps ?? [],
    connectorApps: previous?.connectorApps ?? [],
    appsFetchedAt: update.apps ? Date.now() : previous?.appsFetchedAt,
    connectorAppsFetchedAt: update.connectorApps ? Date.now() : previous?.connectorAppsFetchedAt,
    ...update,
    fetchedAt: Date.now(),
  }
  setPluginMarketplaceCache(next, { ...options, persistImmediately: options?.mutation })
  return getPluginMarketplaceCache(cacheKey)!
}

/** Logo/detail hydration does not invalidate an in-flight membership refresh. */
export function samePluginInstallations(
  left: InstalledPlugin[],
  right: InstalledPlugin[]
): boolean {
  const signature = (plugins: InstalledPlugin[]) =>
    JSON.stringify(
      plugins.map(plugin => {
        const { interface: presentation, components, ...spec } = plugin.spec
        void presentation
        void components
        return { ...plugin, spec }
      })
    )
  return signature(left) === signature(right)
}

/** Publish an accepted settings change to every view without waiting for a reload. */
export function updatePluginInventoryInstallation(
  cacheKey: string,
  id: string | number,
  updated: InstalledPlugin,
  request: Partial<Pick<InstalledPlugin['spec'], 'enabled' | 'componentStates' | 'updatePolicy'>>
): void {
  if (!updated?.metadata || !updated.spec?.source || !updated.spec.components) {
    throw new Error('Invalid installed plugin update')
  }
  const current = getPluginMarketplaceCache(cacheKey)
  if (!current) return
  const installedPlugins = current.installedPlugins.map(plugin => {
    const labels = plugin.metadata.labels as Record<string, unknown> | undefined
    if (String(labels?.id) !== String(id)) return plugin
    // Settings responses describe the cloud target, not the materialized device
    // release. Apply only fields owned by this request to the current inventory.
    const spec = { ...plugin.spec }
    if (request.enabled !== undefined) spec.enabled = updated.spec.enabled
    if (request.updatePolicy !== undefined) spec.updatePolicy = updated.spec.updatePolicy
    if (request.componentStates) {
      spec.componentStates = { ...spec.componentStates }
      for (const key of Object.keys(request.componentStates)) {
        const value = updated.spec.componentStates?.[key]
        if (typeof value !== 'boolean') throw new Error('Invalid plugin component settings update')
        spec.componentStates[key] = value
      }
    }
    return {
      ...plugin,
      spec,
      status:
        request.enabled === undefined
          ? plugin.status
          : { ...plugin.status, state: updated.status.state },
    }
  })
  writePluginInventory(cacheKey, current.deviceId, { installedPlugins }, { mutation: true })
}

/** A disk peek is additive; only complete device inventory can establish absence. */
function mergePartialInventory(previous: InstalledPlugin[], incoming: InstalledPlugin[]) {
  const plugins = new Map(previous.map(plugin => [installationIdentity(plugin), plugin]))
  for (const plugin of incoming) {
    const key = installationIdentity(plugin)
    if (!plugins.has(key)) plugins.set(key, plugin)
  }
  return [...plugins.values()]
}

function installationIdentity(plugin: InstalledPlugin): string {
  return plugin.spec.pluginId != null
    ? `cloud:${plugin.spec.pluginId}`
    : `${plugin.spec.source.marketplace || plugin.spec.source.providerKey}:${plugin.spec.source.pluginKey}`
}

/** Commit accepted install/copy results before notifying any composer or catalog reader. */
export function commitPluginInventoryInstallation(
  cacheKey: string,
  deviceId: string,
  plugin: InstalledPlugin,
  marketplaceItems?: PluginMarketplaceCacheSnapshot['marketplaceItems']
): void {
  const current = getPluginMarketplaceCache(cacheKey)
  if (current?.deviceId && current.deviceId !== deviceId) return
  const identity = installationIdentity(plugin)
  writePluginInventory(
    cacheKey,
    deviceId,
    {
      installedPlugins: [
        plugin,
        ...(current?.installedPlugins ?? []).filter(
          item => installationIdentity(item) !== identity
        ),
      ],
      ...(marketplaceItems ? { marketplaceItems } : {}),
    },
    { mutation: true }
  )
}

/** Reads may enrich the catalog, but cannot roll back a confirmed mutation. */
export function pluginInventoryReadIsCurrent(
  cacheKey: string,
  initial: PluginMarketplaceCacheSnapshot | null
): boolean {
  const current = getPluginMarketplaceCache(cacheKey)
  return (
    (current?.mutationRevision ?? 0) === (initial?.mutationRevision ?? 0) &&
    (!initial?.deviceId || current?.deviceId === initial.deviceId)
  )
}

export function hasLoadedPluginInventory(snapshot: PluginMarketplaceCacheSnapshot | null): boolean {
  return Boolean(snapshot?.installedPlugins.length || snapshot?.installedPluginsFetchedAt)
}

/** Management reads membership only; marketplace catalogs are not a dependency. */
export async function refreshInstalledPluginInventory(options: {
  cacheKey: string
  readLocal: () => Promise<{ items: InstalledPlugin[]; deviceId?: string }>
  readCloud: (deviceId: string | undefined) => Promise<{ items: InstalledPlugin[] }>
  isCurrent: () => boolean
}): Promise<void> {
  let expected = getPluginMarketplaceCache(options.cacheKey)
  let deviceId = expected?.deviceId || ''
  const canPublish = () => {
    const current = getPluginMarketplaceCache(options.cacheKey)
    return (
      options.isCurrent() &&
      (current === expected || !current?.deviceId || current.deviceId === deviceId) &&
      pluginInventoryReadIsCurrent(options.cacheKey, expected) &&
      current?.installedPluginsFetchedAt === expected?.installedPluginsFetchedAt &&
      (current === expected ||
        samePluginInstallations(current?.installedPlugins ?? [], expected?.installedPlugins ?? []))
    )
  }
  const local = await options.readLocal()
  deviceId = local.deviceId || deviceId
  if (!canPublish()) return
  // A cold page can display local packages while cloud membership is pending.
  // Never mark this partial inventory complete or replace existing cached rows.
  if (local.items.length && !expected?.installedPlugins.length) {
    expected = writePluginInventory(options.cacheKey, deviceId, {
      installedPlugins: mergeInstalledPlugins([], local.items, deviceId),
    })
  }
  const cloud = await options.readCloud(deviceId || undefined)
  if (!canPublish()) return
  publishPluginInvocationCatalog(deviceId, local.items, cloud.items)
  writePluginInventory(options.cacheKey, deviceId, {
    installedPlugins: mergeInstalledPlugins(cloud.items, local.items, deviceId, true),
    installedPluginsFetchedAt: Date.now(),
  })
}

/** Transport reads commit complete records before any view derives its fields. */
export async function loadPluginInventory(options: {
  cacheKey: string
  deviceId: string
  readLocalInstalledPlugins: () => Promise<InstalledPlugin[]>
  listCloudInstalledPlugins: () => Promise<InstalledPlugin[]>
  isCurrent: () => boolean
  partial?: boolean
  cloudMembershipAuthoritative?: boolean
}): Promise<PluginMarketplaceCacheSnapshot | null> {
  const initial = getPluginMarketplaceCache(options.cacheKey)
  const [local, cloud] = await Promise.all([
    options.readLocalInstalledPlugins(),
    options.listCloudInstalledPlugins(),
  ])
  if (!options.isCurrent()) return null
  const current = getPluginMarketplaceCache(options.cacheKey)
  // An install/uninstall or another inventory refresh that committed while this
  // request was in flight wins. Late reads cannot resurrect removed plugins.
  if (
    !pluginInventoryReadIsCurrent(options.cacheKey, initial) ||
    (current !== initial &&
      !samePluginInstallations(current?.installedPlugins ?? [], initial?.installedPlugins ?? []))
  ) {
    return current
  }
  publishPluginInvocationCatalog(options.deviceId, local, cloud)
  return writePluginInventory(options.cacheKey, options.deviceId, {
    ...(!options.partial ? { installedPluginsFetchedAt: Date.now() } : {}),
    installedPlugins: options.partial
      ? mergePartialInventory(
          current?.deviceId === options.deviceId ? current.installedPlugins : [],
          mergeInstalledPlugins(
            cloud,
            local,
            options.deviceId,
            options.cloudMembershipAuthoritative
          )
        )
      : mergeInstalledPlugins(cloud, local, options.deviceId, options.cloudMembershipAuthoritative),
  })
}
