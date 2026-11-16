import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { createPluginApi } from '@/api/plugins'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
// Keep memoized callbacks in independent scopes so they cannot retain prior provider renders.
import { listWegentInstalledConnectorApps } from '@/api/cloud/connectorApps'
import {
  peekLocalCodexPluginsReadState,
  readLocalInstalledInventoryFromDisk,
} from '@/api/local/codexPlugins'
import { notifyComposerAppsListeners } from '@/components/chat/composer/composerAppsSnapshot'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'
import { isSystemApplicationConnectorSlug } from '@/features/plugins/builtinPlugins'
import {
  hydratePluginInventoryLogos,
  loadPluginInventory,
  pluginInventoryReadIsCurrent,
  samePluginInstallations,
  selectComposerPluginApps,
  writePluginInventory,
} from '@/features/plugins/pluginInventory'
import { sameLocalPluginSources } from '@/features/plugins/pluginInventorySources'
import { publishPluginInvocationCatalog } from '@/features/plugins/pluginInvocationTelemetry'
import {
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  type PluginMarketplaceCacheSnapshot,
} from '@/features/plugins/pluginMarketplaceCache'
import type { LocalDeviceApp } from '@/types/api'
import {
  isWegentManagedStorePlugin,
  localMatchesCloudPlugin,
} from '@wegent/chat-core/installed-plugin-merge'
import type { RefObject } from 'react'
import { useCallback } from 'react'
const LOCAL_SKILLS_CACHE_TTL_MS = 30_000
export function useListLocalApps({
  localAppsRequestedRef,
  cloudConnection,
  projectPluginNamesRef,
  localAppsInflightRef,
  localAppsLoadGenerationRef,
  cloudPluginApi,
  localPluginApi,
}: {
  localAppsRequestedRef: RefObject<boolean>
  cloudConnection: CloudConnectionContextValue
  projectPluginNamesRef: RefObject<Set<string> | null>
  localAppsInflightRef: RefObject<Promise<LocalDeviceApp[]> | null>
  localAppsLoadGenerationRef: RefObject<number>
  cloudPluginApi: ReturnType<typeof createPluginApi>
  localPluginApi: LocalCodexPluginApi
}) {
  return useCallback(
    async (options?: { supersedeInstalledRequest?: boolean }) => {
      localAppsRequestedRef.current = true
      const cacheKey = pluginMarketplaceCacheKey(cloudConnection.apiBaseUrl, cloudConnection.token)
      const projectSnapshot = (snapshot: PluginMarketplaceCacheSnapshot | null) => {
        if (snapshot)
          publishPluginInvocationCatalog(snapshot.deviceId, snapshot.installedPlugins, [])
        const apps = snapshot
          ? selectComposerPluginApps(snapshot, projectPluginNamesRef.current ?? undefined)
          : []
        notifyComposerAppsListeners()
        return apps
      }
      if (localAppsInflightRef.current) return localAppsInflightRef.current

      const generation = localAppsLoadGenerationRef.current
      const isCurrent = () => generation === localAppsLoadGenerationRef.current
      const loadPromise = (async () => {
        const deviceId =
          peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId?.trim() ||
          peekLocalCodexPluginsReadState()?.deviceId?.trim() ||
          (await ensureLocalExecutorStarted()).deviceId?.trim()
        if (!deviceId) throw new Error('Composer plugin inventory requires a device ID')
        if (!isCurrent()) return []
        const cached = getPluginMarketplaceCache(cacheKey)
        const hasFreshInventory =
          !options?.supersedeInstalledRequest &&
          cached?.deviceId === deviceId &&
          (cached.installedPluginsFetchedAt ?? 0) + LOCAL_SKILLS_CACHE_TTL_MS > Date.now() &&
          [...(projectPluginNamesRef.current ?? [])].every(name =>
            cached.installedPlugins.some(plugin => plugin.spec.source.pluginKey === name)
          )
        // Disk membership is cheap and can change outside this renderer (ZIP
        // import, CLI, restart). Presentation freshness never replaces this read.
        const localInstalled = readLocalInstalledInventoryFromDisk()
        const cloudInstalled = (async () => {
          if (!cloudConnection.isConnected) return undefined
          if (hasFreshInventory) {
            const local = await localInstalled
            // Unknown managed files may be awaiting an acknowledged uninstall's cleanup.
            if (
              local.items.every(
                plugin =>
                  !isWegentManagedStorePlugin(plugin) ||
                  cached.installedPlugins.some(installed =>
                    localMatchesCloudPlugin(plugin, installed)
                  )
              )
            )
              return undefined
          }
          return (await cloudPluginApi.listInstalledPlugins(deviceId)).items
        })()
        const snapshot = await loadPluginInventory({
          cacheKey,
          deviceId,
          readLocalInstalledPlugins: () => localInstalled,
          listCloudInstalledPlugins: () => cloudInstalled,
          isCurrent,
          partial: true,
          cloudMembershipAuthoritative: cloudConnection.isConnected,
        })
        if (!snapshot || !isCurrent()) return []
        const apps = projectSnapshot(snapshot)

        // Enrich the same domain cache asynchronously. Remote catalogs must not
        // block locally installed plugins or overwrite a newer installation.
        window.setTimeout(() => {
          if (!isCurrent()) return
          const installedAtStart = snapshot.installedPlugins
          if (!hasFreshInventory)
            void Promise.all([
              localPluginApi.listInstalledPlugins({
                requireComplete: true,
              }),
              cloudInstalled,
            ])
              .then(([local, cloud]) => {
                if (!isCurrent() || !pluginInventoryReadIsCurrent(cacheKey, snapshot)) return
                const current = getPluginMarketplaceCache(cacheKey)
                if (!current || current.deviceId !== deviceId) return
                if (!sameLocalPluginSources(current, snapshot)) return
                if (!samePluginInstallations(current.installedPlugins, installedAtStart)) return
                return loadPluginInventory({
                  cacheKey,
                  deviceId,
                  readLocalInstalledPlugins: async () => local,
                  listCloudInstalledPlugins: async () => cloud,
                  isCurrent,
                  cloudMembershipAuthoritative: cloudConnection.isConnected,
                })
              })
              .catch(error => {
                if (isCurrent())
                  console.warn('[Wework] Failed to refresh complete plugin inventory.', error)
              })

          void hydratePluginInventoryLogos(
            cacheKey,
            snapshot,
            plugin => {
              const labels = plugin.metadata.labels
              const id =
                labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : null
              return localPluginApi.readInstalledPluginForTrial(
                typeof id === 'string' || typeof id === 'number' ? id : String(plugin.metadata.name)
              )
            },
            isCurrent
          ).catch(error => {
            if (isCurrent()) console.warn('[Wework] Failed to enrich composer plugin logos.', error)
          })

          if (
            cloudConnection.isConnected &&
            cloudConnection.apiBaseUrl &&
            cloudConnection.token &&
            (options?.supersedeInstalledRequest ||
              !snapshot.connectorAppsFetchedAt ||
              snapshot.connectorAppsFetchedAt + LOCAL_SKILLS_CACHE_TTL_MS <= Date.now())
          ) {
            void listWegentInstalledConnectorApps(cloudConnection.apiBaseUrl, cloudConnection.token)
              .then(async installedConnectors => {
                if (!isCurrent() || !pluginInventoryReadIsCurrent(cacheKey, snapshot)) return
                const connected = installedConnectors.apps.filter(
                  app => app.enabled && app.callable
                )
                const synced = await requestLocalExecutor<{
                  apps: Array<{ slug: string; skillPath: string }>
                }>('runtime.connectors.apps.sync', {
                  apps: connected.map(app => ({
                    slug: app.slug,
                    name: app.runtime_name ?? app.slug,
                    description: app.description ?? '',
                    tools: app.tool_summaries ?? [],
                  })),
                })
                if (!isCurrent() || !pluginInventoryReadIsCurrent(cacheKey, snapshot)) return
                const paths = new Map(synced.apps.map(app => [app.slug, app.skillPath]))
                if (getPluginMarketplaceCache(cacheKey)?.deviceId !== deviceId) return
                writePluginInventory(cacheKey, deviceId, {
                  connectorApps: connected
                    .filter(app => !isSystemApplicationConnectorSlug(app.slug))
                    .map(app => ({
                      id: `wegent:${app.slug}`,
                      name: app.runtime_name ?? app.slug,
                      description: app.description ?? '',
                      logoUrl: app.icon_url ?? null,
                      isAccessible: true,
                      isEnabled: true,
                      pluginDisplayNames: ['Wegent Cloud'],
                      source: 'wegent-connector',
                      skillPath: paths.get(app.slug) ?? null,
                    })),
                })
              })
              .catch(error => {
                if (isCurrent())
                  console.warn('[Wework] Failed to load Wegent connector apps.', error)
              })
          }
        }, 0)
        return apps
      })()
      localAppsInflightRef.current = loadPromise
      try {
        return await loadPromise
      } finally {
        if (localAppsInflightRef.current === loadPromise) localAppsInflightRef.current = null
      }
    },
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.isConnected,
      cloudConnection.token,
      cloudPluginApi,
      localAppsInflightRef,
      localAppsLoadGenerationRef,
      localAppsRequestedRef,
      localPluginApi,
      projectPluginNamesRef,
    ]
  )
}
