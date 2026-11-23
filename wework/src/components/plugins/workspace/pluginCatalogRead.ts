import {
  listPersonalMarketplacePluginsFromDisk,
  peekLocalCodexPluginsReadState,
} from '@/api/local/codexPlugins'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import {
  getPluginMarketplaceCache,
  sameInstalledPlugins,
  sameMarketplaceItems,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import {
  writePluginInventory,
  pluginInventoryReadIsCurrent,
} from '@/features/plugins/pluginInventory'
import {
  indexLocalPluginSources,
  resolveLocalPluginInventory,
  sameLocalPluginSources,
} from '@/features/plugins/pluginInventorySources'
import { logPluginRefreshPhase } from '@/features/plugins/pluginRefreshDiagnostics'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { holdBackInFlightMarketplaceInstalls } from '../holdBackInFlightMarketplaceInstalls'
import { hasLocalCodexMaterialization } from '../installedPluginMerge'
import { retainMarketplaceInstalledState } from '../retainMarketplaceInstallHints'
import { mergeInstalledPlugins, resolveProgressiveLocalInstalledRaw } from '../installedPluginMerge'
import { mergeDiskPersonalIntoLocalRows, mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'
import { marketplacePluginDistribution } from '../pluginDistribution'
import {
  cloudMarketplaceKey,
  isCodexCatalogItem,
  marketplaceComponentCount,
  mergeWarmMarketplaceItems,
  nonCodexCatalogItems,
  preferNonEmptyCatalogRows,
  toInstalledPluginItem,
  toMarketplaceOptions,
} from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginCatalogContext } from './pluginCatalogState'
export function loadPluginCatalog(ctx: PluginCatalogContext) {
  const refreshTick = ctx.state.marketplaceRefreshTick
  let isCurrent = true
  const owner = ctx.epoch
  const inventoryAtStart = getPluginMarketplaceCache(ctx.key)
  let sourceExpected = inventoryAtStart
  const cached =
    ctx.input.knownExecutorDeviceId &&
    inventoryAtStart?.deviceId !== ctx.input.knownExecutorDeviceId
      ? null
      : inventoryAtStart
  // A new device owns this read; keep the original mutation revision while
  // allowing its first publication to replace the untouched old-device cache.
  const inventoryReadBaseline =
    inventoryAtStart && ctx.input.knownExecutorDeviceId
      ? { ...inventoryAtStart, deviceId: ctx.input.knownExecutorDeviceId }
      : inventoryAtStart
  const inventoryReadIsCurrent = () =>
    isCurrent &&
    owner !== null &&
    ctx.epoch === owner &&
    (!ctx.input.knownExecutorDeviceId ||
      getKnownLocalExecutorDeviceId() === ctx.input.knownExecutorDeviceId) &&
    sameLocalPluginSources(getPluginMarketplaceCache(ctx.key), sourceExpected) &&
    (getPluginMarketplaceCache(ctx.key) === inventoryAtStart ||
      pluginInventoryReadIsCurrent(ctx.key, inventoryReadBaseline))
  ctx.publish({ inventoryComplete: false })
  ctx.publish({ localInstalledStateReadyKey: null })
  const reportReadFailure = () => {
    if (!inventoryReadIsCurrent()) return
    ctx.publish({ inventoryComplete: false })
    ctx.publish({ localInstalledStateReadyKey: null })
    ctx.publish({
      pluginOperationNotice: {
        id: 'plugin-catalog-load',
        kind: 'error',
        message: ctx.input.t('workbench.plugins_load_failed', '加载插件失败'),
      },
    })
  }
  const hasCachedCatalog = Boolean(cached?.marketplaceItems.length)
  const isExplicitRefresh = refreshTick > ctx.ledger.lastMarketplaceRefreshTick
  const catalogStartedAt = Date.now()
  if (isExplicitRefresh) logPluginRefreshPhase('catalog-start', { request: refreshTick })
  const trackCatalogRead = <T>(phase: string, read: Promise<T>): Promise<T> =>
    read.finally(() => {
      if (isExplicitRefresh)
        logPluginRefreshPhase(phase, {
          request: refreshTick,
          elapsedMs: Date.now() - catalogStartedAt,
          current: isCurrent,
        })
    })
  if (isExplicitRefresh) {
    ctx.ledger.lastMarketplaceRefreshTick = refreshTick
  }
  const deviceIdHint =
    ctx.input.knownExecutorDeviceId || cached?.deviceId || ctx.state.currentDeviceId || undefined
  const localReadParams = { mergeAllMarketplaces: true as const }
  const localPeek = !isExplicitRefresh ? peekLocalCodexPluginsReadState(localReadParams) : null
  const peekedLocalState =
    ctx.input.knownExecutorDeviceId && localPeek?.deviceId !== ctx.input.knownExecutorDeviceId
      ? null
      : localPeek
  const currentCache = () => {
    const value = getPluginMarketplaceCache(ctx.key)
    return ctx.input.knownExecutorDeviceId && value?.deviceId !== ctx.input.knownExecutorDeviceId
      ? null
      : value
  }
  const hasDurablePeek = Boolean(peekedLocalState?.marketplaceItems.length)
  if (!hasCachedCatalog && !hasDurablePeek) {
    ctx.publish({
      marketplaceCatalogState: (previous => ({
        ...previous,
        isLoading: previous.items.length === 0,
        error: null,
      }))(ctx.state.marketplaceCatalogState),
    })
  } else {
    // Cache-first / durable-peek: keep the catalog mounted while revalidating.
    // Flipping isLoading made action buttons vanish mid-click and flashed empty tabs.
    // Silent background revalidate when we already have a painted/cached catalog —
    // returning from background must not look like a full marketplace reload.
    const alreadyPainted = ctx.catalog.items.length > 0 || hasCachedCatalog || hasDurablePeek
    if (isExplicitRefresh) {
      ctx.publish({ isMarketplaceRefreshing: true })
    } else if (alreadyPainted) {
      ctx.publish({ isMarketplaceRefreshing: false })
    } else {
      ctx.publish({ isMarketplaceRefreshing: true })
    }
    ctx.publish({
      marketplaceCatalogState: (previous => ({
        ...previous,
        isLoading: false,
        error: null,
        ...(previous.items.length === 0
          ? {
              items: mergeWarmMarketplaceItems(cached, peekedLocalState),
            }
          : {}),
      }))(ctx.state.marketplaceCatalogState),
    })
    const warmInstalled = (cached?.installedPlugins ?? []).map(toInstalledPluginItem)
    if (cached || warmInstalled.length > 0) {
      // All installed rows come from the shared domain inventory.
      ctx.publish({
        installedPlugins: (previous =>
          sameInstalledPlugins(previous, warmInstalled) ? previous : warmInstalled)(
          ctx.state.installedPlugins
        ),
      })
    }
    if (peekedLocalState && ctx.state.marketplaces.length === 0) {
      ctx.applyLocalMarketplaceState(peekedLocalState)
    }
  }
  const hasGithubMarketplace = (cached?.marketplaces ?? ctx.state.marketplaces).some(
    entry => entry.kind === 'local' && /^https?:\/\/github\.com\//i.test(entry.path || '')
  )
  if ((!hasCachedCatalog && !hasDurablePeek) || isExplicitRefresh) {
    ctx.publish({
      marketplaceLoadingMessage: hasGithubMarketplace
        ? isExplicitRefresh
          ? ctx.input.t(
              'workbench.plugins_refreshing_github_marketplace',
              '正在刷新 GitHub 插件市场'
            )
          : ctx.input.t(
              'workbench.plugins_syncing_github_marketplace',
              '正在同步 GitHub 插件市场，首次添加时需要 clone 仓库。'
            )
        : isExplicitRefresh
          ? ctx.input.t('workbench.plugins_refreshing_marketplace', '正在刷新插件市场')
          : ctx.input.t('workbench.plugins_loading_marketplace', '正在加载插件市场'),
    })
  }
  // Catalog loads stay query-agnostic; search filters client-side from the cached list.
  // Reconcile Wework official, enterprise, and personal-created first. GitHub
  // plugin/list is last because it shares the Codex app-server lock with
  // plugin/install.
  let localInstalledReadFailed = false
  let personalDiskReadFailed = false
  let localInventory: ReturnType<typeof resolveLocalPluginInventory> | null = null
  const localSourceMetadata = (installed: InstalledPlugin[], deviceId: string) =>
    localInventory
      ? {
          localInstalledSources: indexLocalPluginSources(
            installed,
            localInventory.sourceItems,
            deviceId
          ),
          localInstalledSourceStatus: localInventory.localInstalledSourceStatus,
        }
      : {}
  const membershipPromise = ctx.input.localPluginApi
    .listInstalledPlugins({
      refresh: true,
    })
    .then(result => {
      if (!inventoryReadIsCurrent()) return result
      const deviceId =
        ctx.input.knownExecutorDeviceId ||
        result.deviceId ||
        ctx.state.currentDeviceId ||
        deviceIdHint ||
        ''
      localInventory = resolveLocalPluginInventory(currentCache(), result, deviceId)
      localInstalledReadFailed =
        result.partial === true ||
        Object.values(localInventory.localInstalledSourceStatus).includes('rejected')
      if (localInstalledReadFailed) reportReadFailure()
      return { ...result, items: localInventory.items, partial: localInstalledReadFailed }
    })
    .catch(error => {
      localInstalledReadFailed = true
      reportReadFailure()
      throw error
    })
  const localPromise = Promise.resolve(peekedLocalState)
  // Use a known device id when available (cache / prior load). Otherwise start cloud
  // immediately for progressive first paint; a device-scoped pass follows once local
  // resolves the device id.
  const readCloudCatalog = (deviceId?: string) =>
    ctx.input.pluginApi.listMarketplacePlugins({ deviceId }).then(response => {
      if (!Array.isArray(response.items)) throw new Error('Invalid plugin catalog')
      mergeMarketplaceCatalog(response.items, [], [])
      response.items.forEach(marketplaceComponentCount)
      return response
    })
  const readCloudInstalled = (deviceId?: string) =>
    ctx.input.pluginApi.listInstalledPlugins(deviceId).then(response => {
      if (!Array.isArray(response.items)) throw new Error('Invalid installed plugins')
      mergeInstalledPlugins(response.items, [], deviceId).map(toInstalledPluginItem)
      return response
    })
  const cloudPromise = ctx.input.cloudMarketplaceAvailable
    ? readCloudCatalog(deviceIdHint || peekedLocalState?.deviceId)
    : Promise.resolve({ items: [] as PluginMarketplaceItem[] })
  let installedReadFailed = false
  const installedPromise = readCloudInstalled(deviceIdHint || peekedLocalState?.deviceId).catch(
    error => {
      installedReadFailed = true
      reportReadFailure()
      throw error
    }
  )
  // Live plugin/installed membership. Peek / plugin/list must not satisfy this.
  let liveLocalInstalledForMerge: InstalledPlugin[] | null = null
  // Only the applied live catalog may schedule local reconciliation. Cache
  // paints can look device-ready while a pending cloud row is still in flight.
  const markAutoSyncInventoryReady = () => {
    if (!isCurrent || ctx.epoch !== owner) return
    ctx.publish({ catalogReadReadyKey: `${ctx.key}:${refreshTick}` })
    if (!ctx.state.inventoryComplete) return
    ctx.publish({ localInstalledStateReadyKey: ctx.key })
    ctx.publish({
      pluginOperationNotice: (current => (current?.id === 'plugin-catalog-load' ? null : current))(
        ctx.state.pluginOperationNotice
      ),
    })
  }
  const applyCatalogSnapshot = (
    cloudItems: PluginMarketplaceItem[] | null,
    cloudInstalled: InstalledPlugin[] | null,
    localState: Awaited<ReturnType<typeof ctx.input.localPluginApi.readState>> | null,
    options?: {
      preferExistingOnSameSignature?: boolean
      keepLoadingWhenEmpty?: boolean
      deferInventoryReady?: boolean
    }
  ) => {
    if (!inventoryReadIsCurrent()) return
    const preferredLocal = (
      liveLocalInstalledForMerge ??
      (localState && (peekedLocalState == null || localState !== peekedLocalState)
        ? localState.installedPlugins
        : (localState?.installedPlugins ?? ctx.state.installedPlugins.map(plugin => plugin.raw)))
    ).filter(hasLocalCodexMaterialization)
    const nextInstalledRaw = mergeInstalledPlugins(
      cloudInstalled ??
        cloudInstalledForMerge ??
        (currentCache()?.installedPlugins ?? []).filter(
          plugin => typeof plugin.spec.pluginId === 'number'
        ),
      preferredLocal,
      localState?.deviceId || deviceIdHint || ctx.state.currentDeviceId || '',
      ctx.input.cloudMarketplaceAvailable && !installedReadFailed
    ).map(toInstalledPluginItem)
    const cachedMarketplaceItems = currentCache()?.marketplaceItems ?? []
    const previousMarketplaceItems =
      ctx.catalog.items.length > 0 ? ctx.catalog.items : cachedMarketplaceItems
    const localRows = mergeDiskPersonalIntoLocalRows(
      preferNonEmptyCatalogRows(
        localState?.marketplaceItems?.filter(keepPersonalDiskRow),
        cachedMarketplaceItems.filter(isCodexCatalogItem).filter(keepPersonalDiskRow)
      ),
      mergeDiskPersonalIntoLocalRows(
        diskPersonalItemsForMerge ?? [],
        previousMarketplaceItems.filter(
          item => marketplacePluginDistribution(item) === 'personal' && keepPersonalDiskRow(item)
        )
      )
    )
    const resolvedCloudItems = cloudItems ?? nonCodexCatalogItems(previousMarketplaceItems)
    const retained = retainMarketplaceInstalledState({
      previousItems: previousMarketplaceItems,
      nextItems: mergeMarketplaceCatalog(
        resolvedCloudItems,
        localRows,
        nextInstalledRaw.map(plugin => plugin.raw)
      ),
      previousInstalled: ctx.state.installedPlugins,
      nextInstalled: nextInstalledRaw,
      previousStateMatchesScope: ctx.key === ctx.key,
      authoritativeInstalledState: localInventory !== null,
    })
    const heldBack = holdBackInFlightMarketplaceInstalls({
      items: retained.items,
      installed: retained.installed,
      installingIds: ctx.input.installingMarketplacePluginIds,
      authPluginKey:
        ctx.input.pendingLocalConnectorAuth?.purpose === 'install'
          ? ctx.input.pendingLocalConnectorAuth.target.pluginKey
          : null,
    })
    const nextInstalled = heldBack.installed
    const mergedItems = heldBack.items
    ctx.publish({
      installedPlugins: (previous =>
        sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled)(
        ctx.state.installedPlugins
      ),
    })
    if (cloudInstalled !== null && ctx.input.cloudMarketplaceAvailable)
      ctx.ledger.cloudMembershipAuthoritative = true
    ctx.publish({
      marketplaceCatalogState: (previous => {
        if (
          options?.preferExistingOnSameSignature &&
          sameMarketplaceItems(previous.items, mergedItems) &&
          !previous.error
        ) {
          return {
            ...previous,
            isLoading: mergedItems.length === 0 && Boolean(options.keepLoadingWhenEmpty),
            error: null,
          }
        }
        return {
          items: mergedItems,
          isLoading: mergedItems.length === 0 && Boolean(options?.keepLoadingWhenEmpty),
          error: null,
        }
      })(ctx.state.marketplaceCatalogState),
    })
    const nextMarketplaces =
      localState != null
        ? toMarketplaceOptions(
            localState.marketplaces,
            ctx.input.cloudMarketplaceAvailable,
            ctx.input.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
          )
        : ctx.state.marketplaces
    setPluginMarketplaceCache(
      {
        cacheKey: ctx.key,
        marketplaceItems: mergedItems,
        installedPlugins: nextInstalled.map(plugin => plugin.raw),
        ...localSourceMetadata(
          nextInstalled.map(plugin => plugin.raw),
          localState?.deviceId || deviceIdHint || ctx.state.currentDeviceId || ''
        ),
        marketplaces: nextMarketplaces,
        selectedMarketplaceKey: ctx.state.selectedMarketplaceKey,
        deviceId: localState?.deviceId || deviceIdHint || ctx.state.currentDeviceId || '',
        fetchedAt: Date.now(),
      },
      { persistImmediately: true }
    )
    sourceExpected = getPluginMarketplaceCache(ctx.key)
    if (!options?.deferInventoryReady) markAutoSyncInventoryReady()
  }
  // Paint whichever side arrives first so a slow Codex plugin/list (~10s remote
  // refresh) cannot block an already-fast cloud marketplace response, and vice versa.
  let catalogSettled = false
  let localStateForMerge: Awaited<ReturnType<typeof ctx.input.localPluginApi.readState>> | null =
    null
  let cloudItemsForMerge: PluginMarketplaceItem[] | null = null
  let cloudInstalledForMerge: InstalledPlugin[] | null = null
  let diskPersonalItemsForMerge: PluginMarketplaceItem[] | null = null
  const keepPersonalDiskRow = (item: PluginMarketplaceItem) =>
    diskPersonalItemsForMerge === null || !String(item.id).startsWith('personal-disk:')
  const paintPartialCatalog = (options: {
    cloudItems?: PluginMarketplaceItem[]
    cloudInstalled?: InstalledPlugin[]
    localState?: Awaited<ReturnType<typeof ctx.input.localPluginApi.readState>> | null
    liveLocalInstalled?: InstalledPlugin[]
    diskPersonalItems?: PluginMarketplaceItem[]
    keepRefreshing: boolean
    ignoreSettled?: boolean
  }) => {
    if (!inventoryReadIsCurrent() || (catalogSettled && !options.ignoreSettled)) return
    const localState = options.localState ?? null
    if (options.liveLocalInstalled) {
      liveLocalInstalledForMerge = options.liveLocalInstalled
    }
    if (localState) {
      localStateForMerge = localState
      // A successful live readState snapshot is authoritative, including an
      // empty install list after the user uninstalls the last package.
      if (
        !localInventory &&
        (peekedLocalState == null || localState !== peekedLocalState) &&
        !localState.partial
      ) {
        liveLocalInstalledForMerge = localState.installedPlugins
      }
      ctx.publish({ currentDeviceId: localState.deviceId })
      ctx.applyLocalMarketplaceState(localState)
    }
    if (options.cloudItems) {
      cloudItemsForMerge = options.cloudItems
    }
    if (options.cloudInstalled) {
      cloudInstalledForMerge = options.cloudInstalled
    }
    if (options.diskPersonalItems) {
      diskPersonalItemsForMerge = options.diskPersonalItems
    }
    // Cloud can arrive before Codex marketplaces; seed the cloud tab so the catalog
    // is not replaced by the empty "cloud unavailable" empty-state.
    if (options.cloudItems && !localStateForMerge && ctx.state.marketplaces.length === 0) {
      const seeded = toMarketplaceOptions(
        [],
        ctx.input.cloudMarketplaceAvailable,
        ctx.input.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
      )
      if (seeded.length > 0) {
        ctx.publish({ marketplaces: seeded })
        const cloudKey = ctx.input.cloudMarketplaceAvailable ? cloudMarketplaceKey() : ''
        ctx.publish({
          selectedMarketplaceKey: (current =>
            current ||
            (cloudKey && seeded.some(option => option.key === cloudKey) ? cloudKey : '') ||
            seeded[0]?.key ||
            '')(ctx.state.selectedMarketplaceKey),
        })
      }
    }
    if (
      options.diskPersonalItems?.length &&
      !localStateForMerge &&
      ctx.state.marketplaces.length === 0
    ) {
      const seeded = toMarketplaceOptions(
        [
          {
            id: WEWORK_PERSONAL_MARKETPLACE_ID,
            name: ctx.input.t('workbench.plugins_distribution_personal', '个人创建'),
            path: '',
          },
        ],
        ctx.input.cloudMarketplaceAvailable,
        ctx.input.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
      )
      if (seeded.length > 0) {
        ctx.publish({ marketplaces: seeded })
        const cloudKey = ctx.input.cloudMarketplaceAvailable ? cloudMarketplaceKey() : ''
        ctx.publish({
          selectedMarketplaceKey: (current =>
            current ||
            (cloudKey && seeded.some(option => option.key === cloudKey) ? cloudKey : '') ||
            seeded[0]?.key ||
            '')(ctx.state.selectedMarketplaceKey),
        })
      }
    }
    // Only reuse durable and in-flight data for this account and device.
    const cachedSnapshot = currentCache()
    const hasCachedSnapshot = cachedSnapshot != null
    const cachedMarketplaceItems = cachedSnapshot?.marketplaceItems ?? []
    const cachedCloudItems = cachedMarketplaceItems.filter(item => !isCodexCatalogItem(item))
    const cachedInstalledRaw = cachedSnapshot?.installedPlugins ?? []
    const cachedLocalItems = cachedMarketplaceItems.filter(isCodexCatalogItem)
    const previousItems = ctx.catalog.items.length > 0 ? ctx.catalog.items : cachedMarketplaceItems
    const localRows = mergeDiskPersonalIntoLocalRows(
      preferNonEmptyCatalogRows(
        localStateForMerge?.marketplaceItems?.filter(keepPersonalDiskRow),
        cachedLocalItems.filter(keepPersonalDiskRow)
      ),
      mergeDiskPersonalIntoLocalRows(
        diskPersonalItemsForMerge ?? [],
        previousItems.filter(
          item => marketplacePluginDistribution(item) === 'personal' && keepPersonalDiskRow(item)
        )
      )
    )
    // Never reuse the prior account's React state. A same-device local snapshot may
    // still contribute packages that are physically installed on this device.
    const previousInstalledRaw = hasCachedSnapshot
      ? cachedInstalledRaw
      : (localStateForMerge?.installedPlugins ?? [])
    const localInstalledForMerge =
      liveLocalInstalledForMerge ??
      resolveProgressiveLocalInstalledRaw({
        hasCachedSnapshot,
        cachedInstalledRaw,
        localInstalledRaw: localStateForMerge?.installedPlugins,
        localStateIsPeek:
          peekedLocalState != null &&
          localStateForMerge != null &&
          localStateForMerge === peekedLocalState,
        cachedDeviceId: cachedSnapshot?.deviceId,
        localDeviceId: localStateForMerge?.deviceId,
      })
    // Local-first paint must not blank cloud installs for THIS account. Never keep
    // prior-account strip rows when the current key has no warm snapshot.
    const cloudInstalled =
      cloudInstalledForMerge ??
      (ctx.input.cloudMarketplaceAvailable && hasCachedSnapshot
        ? previousInstalledRaw.filter(plugin => typeof plugin.spec.pluginId === 'number')
        : [])
    const nextInstalledRaw = mergeInstalledPlugins(
      cloudInstalled,
      localInstalledForMerge,
      localStateForMerge?.deviceId || deviceIdHint || ctx.state.currentDeviceId || '',
      ctx.input.cloudMarketplaceAvailable && cloudInstalledForMerge !== null && !installedReadFailed
    ).map(toInstalledPluginItem)
    // Prefer in-flight cloud rows, then this key's durable cache — never stale
    // previous-account React state after a cache miss / account switch.
    const cloudItems = cloudItemsForMerge ?? cachedCloudItems
    const retained = retainMarketplaceInstalledState({
      previousItems: ctx.catalog.items,
      nextItems: mergeMarketplaceCatalog(
        cloudItems,
        localRows,
        nextInstalledRaw.map(plugin => plugin.raw)
      ),
      previousInstalled: ctx.state.installedPlugins,
      nextInstalled: nextInstalledRaw,
      previousStateMatchesScope: ctx.key === ctx.key,
      authoritativeInstalledState: localInventory !== null,
    })
    const heldBack = holdBackInFlightMarketplaceInstalls({
      items: retained.items,
      installed: retained.installed,
      installingIds: ctx.input.installingMarketplacePluginIds,
      authPluginKey:
        ctx.input.pendingLocalConnectorAuth?.purpose === 'install'
          ? ctx.input.pendingLocalConnectorAuth.target.pluginKey
          : null,
    })
    const nextInstalled = heldBack.installed
    const mergedItems = heldBack.items
    // Publish installed rows even when the catalog is still empty — cloud
    // listInstalledPlugins often arrives before marketplace rows.
    if (localStateForMerge || cloudInstalledForMerge) {
      ctx.publish({
        installedPlugins: (previous =>
          sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled)(
          ctx.state.installedPlugins
        ),
      })
    }
    // An incomplete Codex plugin/list after resume can merge to zero rows.
    // Never persist that over a warm catalog — it made every background return
    // look like a first marketplace sync.
    if (mergedItems.length === 0 && cloudItemsForMerge === null && !localStateForMerge) {
      if (liveLocalInstalledForMerge !== null || cloudInstalledForMerge !== null) {
        writePluginInventory(ctx.key, deviceIdHint || ctx.state.currentDeviceId || '', {
          installedPlugins: nextInstalled.map(plugin => plugin.raw),
          ...localSourceMetadata(
            nextInstalled.map(plugin => plugin.raw),
            deviceIdHint || ctx.state.currentDeviceId || ''
          ),
        })
        sourceExpected = getPluginMarketplaceCache(ctx.key)
      }
      if (cloudInstalledForMerge) {
        ctx.publish({ isMarketplaceRefreshing: options.keepRefreshing })
      }
      return
    }
    // Keep the live catalog in memory so later merges see device pending.
    // Persist stays debounced unless this is an explicit refresh.
    const progressiveMarketplaces =
      localStateForMerge != null
        ? toMarketplaceOptions(
            localStateForMerge.marketplaces,
            ctx.input.cloudMarketplaceAvailable,
            ctx.input.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
          )
        : ctx.state.marketplaces
    setPluginMarketplaceCache({
      cacheKey: ctx.key,
      marketplaceItems: mergedItems,
      installedPlugins: nextInstalled.map(plugin => plugin.raw),
      ...localSourceMetadata(
        nextInstalled.map(plugin => plugin.raw),
        localStateForMerge?.deviceId || deviceIdHint || ctx.state.currentDeviceId || ''
      ),
      marketplaces: progressiveMarketplaces,
      selectedMarketplaceKey: ctx.state.selectedMarketplaceKey,
      deviceId: localStateForMerge?.deviceId || deviceIdHint || ctx.state.currentDeviceId || '',
      fetchedAt: Date.now(),
    })
    sourceExpected = getPluginMarketplaceCache(ctx.key)
    ctx.publish({
      marketplaceCatalogState: (previous => {
        const items = getPluginMarketplaceCache(ctx.key)?.marketplaceItems ?? mergedItems
        const isLoading =
          items.length === 0 && liveLocalInstalledForMerge === null && !localStateForMerge
        if (sameMarketplaceItems(previous.items, items) && !previous.error) {
          return { ...previous, isLoading, error: null }
        }
        return { items, isLoading, error: null }
      })(ctx.state.marketplaceCatalogState),
    })
    ctx.publish({ marketplaceLoadingMessage: '' })
    ctx.publish({ isMarketplaceRefreshing: options.keepRefreshing })
  }
  // Always paint durable/local peek early — even when a same-session memory cache
  // already has cloud rows, keeping the OpenAI catalog visible during plugin/list.
  if (peekedLocalState) {
    paintPartialCatalog({
      localState: peekedLocalState,
      // Peek already paints OpenAI/local rows. Only keep the top-bar spinner for an
      // explicit refresh — background revalidation must stay silent.
      keepRefreshing: isExplicitRefresh,
    })
  }
  const personalDiskPromise = listPersonalMarketplacePluginsFromDisk().catch(error => {
    console.warn('[Wework] personal marketplace disk paint failed', error)
    personalDiskReadFailed = true
    reportReadFailure()
    return null
  })
  void personalDiskPromise
    .then(diskPersonalItems => {
      if (!inventoryReadIsCurrent()) return
      if (diskPersonalItems === null) return
      diskPersonalItemsForMerge = diskPersonalItems
      if (catalogSettled) {
        // Final snapshot may have landed before disk I/O; merge personal rows now.
        const cached = currentCache()
        const cloudItems =
          cloudItemsForMerge ??
          (cached?.marketplaceItems ?? []).filter(item => !isCodexCatalogItem(item))
        const localRows = mergeDiskPersonalIntoLocalRows(
          (
            localStateForMerge?.marketplaceItems ??
            (cached?.marketplaceItems ?? []).filter(isCodexCatalogItem)
          ).filter(keepPersonalDiskRow),
          diskPersonalItems
        )
        const cachedInstalledRaw = cached?.installedPlugins ?? []
        const localInstalledForMerge =
          localInventory?.items ??
          resolveProgressiveLocalInstalledRaw({
            hasCachedSnapshot: cached != null,
            cachedInstalledRaw,
            localInstalledRaw: localStateForMerge?.installedPlugins,
            localStateIsPeek:
              peekedLocalState != null &&
              localStateForMerge != null &&
              localStateForMerge === peekedLocalState,
            cachedDeviceId: cached?.deviceId,
            localDeviceId: localStateForMerge?.deviceId,
          })
        const nextInstalledRaw = mergeInstalledPlugins(
          cloudInstalledForMerge ??
            (ctx.input.cloudMarketplaceAvailable && cached != null
              ? cachedInstalledRaw.filter(plugin => typeof plugin.spec.pluginId === 'number')
              : []),
          localInstalledForMerge,
          localStateForMerge?.deviceId || deviceIdHint || ctx.state.currentDeviceId || '',
          ctx.input.cloudMarketplaceAvailable &&
            cloudInstalledForMerge !== null &&
            !installedReadFailed
        ).map(toInstalledPluginItem)
        const retained = retainMarketplaceInstalledState({
          previousItems: ctx.catalog.items,
          nextItems: mergeMarketplaceCatalog(
            cloudItems,
            localRows,
            nextInstalledRaw.map(plugin => plugin.raw)
          ),
          previousInstalled: ctx.state.installedPlugins,
          nextInstalled: nextInstalledRaw,
          previousStateMatchesScope: ctx.key === ctx.key,
          authoritativeInstalledState: localInventory !== null,
        })
        const heldBack = holdBackInFlightMarketplaceInstalls({
          items: retained.items,
          installed: retained.installed,
          installingIds: ctx.input.installingMarketplacePluginIds,
          authPluginKey:
            ctx.input.pendingLocalConnectorAuth?.purpose === 'install'
              ? ctx.input.pendingLocalConnectorAuth.target.pluginKey
              : null,
        })
        const nextInstalled = heldBack.installed
        const mergedItems = heldBack.items
        writePluginInventory(
          ctx.key,
          localStateForMerge?.deviceId || deviceIdHint || ctx.state.currentDeviceId || '',
          {
            installedPlugins: nextInstalled.map(plugin => plugin.raw),
            marketplaceItems: mergedItems,
            ...localSourceMetadata(
              nextInstalled.map(plugin => plugin.raw),
              localStateForMerge?.deviceId || deviceIdHint || ctx.state.currentDeviceId || ''
            ),
          }
        )
        sourceExpected = getPluginMarketplaceCache(ctx.key)
        return
      }
      // Always paint disk personal rows, even when a cloud cache already filled the
      // catalog. Otherwise personal plugins would wait for Codex plugin/list.
      paintPartialCatalog({
        diskPersonalItems,
        localState: localStateForMerge,
        keepRefreshing: isExplicitRefresh,
      })
    })
    .catch(reportReadFailure)
    .finally(() => {
      if (!isCurrent || ctx.epoch !== owner) return
      ctx.publish({ personalDiskSettledKey: ctx.key })
    })
  void localPromise
    .then(localState => {
      if (!localState) return
      localStateForMerge = localState
      // Peek path already painted above; avoid a redundant same-snapshot paint.
      if (peekedLocalState && localState === peekedLocalState) {
        return
      }
      paintPartialCatalog({
        localState,
        diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
        keepRefreshing: isExplicitRefresh,
      })
    })
    .catch(() => undefined)
  // Paint the installed strip as soon as account installs arrive — do not wait on
  // marketplace catalog or Codex plugin/list. That is what made Wework/official
  // icons flash in after OpenAI/local peeks.
  void installedPromise
    .then(installed => {
      if (!isCurrent || ctx.epoch !== owner || catalogSettled) return
      paintPartialCatalog({
        cloudInstalled: installed.items,
        localState: localStateForMerge,
        diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
        keepRefreshing: isExplicitRefresh,
      })
    })
    .catch(reportReadFailure)
  // Membership is a dedicated plugin/installed call. Never wait on plugin/list
  // (OpenAI GitHub reconcile) before auto-sync or device-gap overlay.
  void membershipPromise
    .then(membership => {
      if (!inventoryReadIsCurrent()) return
      liveLocalInstalledForMerge = membership.items
      if (membership.deviceId) {
        ctx.publish({ currentDeviceId: membership.deviceId })
      }
      paintPartialCatalog({
        liveLocalInstalled: membership.items,
        localState: localStateForMerge,
        cloudItems: cloudItemsForMerge ?? undefined,
        cloudInstalled: cloudInstalledForMerge ?? undefined,
        diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
        keepRefreshing: isExplicitRefresh && !catalogSettled,
        ignoreSettled: true,
      })
    })
    .catch(reportReadFailure)
  void cloudPromise
    .then(cloud => {
      if (!isCurrent || catalogSettled) return
      paintPartialCatalog({
        cloudItems: cloud.items,
        localState: localStateForMerge,
        diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
        keepRefreshing: isExplicitRefresh,
      })
    })
    .catch(reportReadFailure)
  // Only live installed inventories and device identity gate reconciliation.
  // Marketplace presentation reads cannot authorize or change this operation.
  void Promise.allSettled([installedPromise, membershipPromise]).then(
    ([installedResult, membershipResult]) => {
      if (!isCurrent || ctx.epoch !== owner) return
      const resolvedDeviceId =
        (membershipResult.status === 'fulfilled' && membershipResult.value.deviceId) ||
        ctx.state.currentDeviceId ||
        deviceIdHint ||
        ''
      const manualRequest = ctx.ledger.manualReconciliationTick
      if (manualRequest && manualRequest.tick <= refreshTick) {
        ctx.ledger.manualReconciliationTick = null
      }
      // Manual reconciliation reads current inventory itself. A newer cache
      // publication invalidates this snapshot, not the user's scoped request.
      if (
        manualRequest &&
        manualRequest.tick <= refreshTick &&
        manualRequest.accountKey === ctx.key &&
        manualRequest.isCurrent() &&
        (!manualRequest.deviceId ||
          (manualRequest.deviceId === ctx.state.currentDeviceId &&
            manualRequest.deviceId === resolvedDeviceId))
      ) {
        if (
          !installedReadFailed &&
          installedResult.status === 'fulfilled' &&
          membershipResult.status === 'fulfilled' &&
          !membershipResult.value.partial
        ) {
          ctx.publish({
            reconciliationScope: {
              accountKey: manualRequest.accountKey,
              deviceId: resolvedDeviceId,
            },
          })
          ctx.publish({
            reconciliationRequest: (previous => previous + 1)(ctx.state.reconciliationRequest),
          })
        } else {
          ctx.publish({
            pluginOperationNotice: {
              id: 'plugin-reconciliation-incomplete',
              kind: 'error',
              message: ctx.input.t(
                'workbench.plugins_reconciliation_incomplete',
                '插件数据未完整加载，本次未执行状态修复，请重试刷新'
              ),
            },
          })
        }
      }
    }
  )
  const settledCatalog = Promise.allSettled([
    trackCatalogRead('catalog-local-settled', localPromise),
    trackCatalogRead('catalog-cloud-settled', cloudPromise),
    trackCatalogRead('catalog-installed-settled', installedPromise),
    trackCatalogRead('catalog-personal-settled', personalDiskPromise),
    trackCatalogRead('catalog-membership-settled', membershipPromise),
  ]).then(([localResult, cloudResult, installedResult, diskResult, membershipResult]) => {
    if (isExplicitRefresh)
      logPluginRefreshPhase('catalog-settled', {
        request: refreshTick,
        elapsedMs: Date.now() - catalogStartedAt,
        current: isCurrent,
      })
    if (!isCurrent || ctx.epoch !== owner) return
    catalogSettled = true
    // Prefer a background-refreshed local snapshot over the settle promise value.
    // Stale-peek SWR resolves localPromise immediately with the peek; a concurrent
    // refresh:true may already have written a newer localStateForMerge.
    const localState =
      localStateForMerge ?? (localResult.status === 'fulfilled' ? localResult.value : null)
    const membershipDeviceId =
      membershipResult.status === 'fulfilled' ? membershipResult.value.deviceId || '' : ''
    const resolvedDeviceId =
      localState?.deviceId || membershipDeviceId || ctx.state.currentDeviceId || deviceIdHint || ''
    ctx.publish({ marketplaceLoadingMessage: '' })
    ctx.publish({ isMarketplaceRefreshing: false })
    if (!inventoryReadIsCurrent()) return
    if (diskResult.status === 'fulfilled' && diskResult.value !== null) {
      diskPersonalItemsForMerge = diskResult.value
    }
    const cloudItems = cloudResult.status === 'fulfilled' ? cloudResult.value.items : null
    const cloudInstalled =
      installedResult.status === 'fulfilled' ? installedResult.value.items : null
    if (localState) {
      ctx.publish({ currentDeviceId: localState.deviceId })
      ctx.applyLocalMarketplaceState(localState)
    } else if (membershipDeviceId) {
      ctx.publish({ currentDeviceId: membershipDeviceId })
    }
    const initialCloudDeviceId = deviceIdHint || peekedLocalState?.deviceId || ''
    const needsDeviceScopedCloudPass =
      ctx.input.cloudMarketplaceAvailable &&
      Boolean(resolvedDeviceId) &&
      resolvedDeviceId !== initialCloudDeviceId
    ctx.publish({
      inventoryComplete:
        cloudResult.status === 'fulfilled' &&
        !installedReadFailed &&
        !localInstalledReadFailed &&
        !personalDiskReadFailed,
    })
    if (!ctx.state.inventoryComplete) reportReadFailure()
    // Unscoped cloud lists describe account membership, not device readiness.
    // Wait for the device-scoped pass before scheduling local reconciliation.
    applyCatalogSnapshot(cloudItems, cloudInstalled, localState, {
      // When durable storage had to drop data-URL logos, always take the network
      // catalog so official plugins do not stay stuck on name initials.
      preferExistingOnSameSignature: !isExplicitRefresh && !cached?.logosStripped,
      keepLoadingWhenEmpty: !peekedLocalState && !localState,
      deferInventoryReady: needsDeviceScopedCloudPass,
    })
    if (needsDeviceScopedCloudPass) {
      void Promise.all([
        readCloudCatalog(resolvedDeviceId).catch(() => {
          reportReadFailure()
          return null
        }),
        readCloudInstalled(resolvedDeviceId).catch(() => {
          installedReadFailed = true
          reportReadFailure()
          return null
        }),
      ])
        .then(([deviceCloud, deviceInstalled]) => {
          if (!isCurrent || ctx.epoch !== owner) return
          // Prefer a background-refreshed local snapshot over the settle-time
          // peek — otherwise device cloud arrival can clobber DISABLED_BY_ADMIN
          // rows that refresh already painted.
          applyCatalogSnapshot(
            deviceCloud?.items ?? null,
            deviceInstalled?.items ?? null,
            localStateForMerge ?? localState,
            {
              preferExistingOnSameSignature: true,
            }
          )
        })
        .catch(() => {
          reportReadFailure()
          if (isCurrent) markAutoSyncInventoryReady()
        })
    }
  })
  void settledCatalog.catch(reportReadFailure)
  return () => {
    isCurrent = false
  }
}
