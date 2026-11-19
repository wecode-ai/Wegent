import { createPluginRecoveryNotice } from './pluginRecoveryNotice'
import type { PluginMarketplaceItem, PluginAccessResponse } from '@/types/api'
import { restorePluginComponentState } from '@/features/plugins/pluginSettingsRequest'
import {
  createLocalCodexPluginApi,
  peekLocalCodexPluginsReadState,
  clearLocalCodexPluginsReadStateCache,
} from '@/api/local/codexPlugins'
import type { createLocalDevicePluginApi } from '@/features/plugins/pluginDeviceApi'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import {
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
  sameInstalledPlugins,
  sameMarketplaceItems,
  subscribePluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import {
  hasSettledPluginDeviceAutoSync,
  marketplaceNeedsDeviceSync,
  subscribePluginDeviceSync,
  markPluginDeviceAutoSyncSettled,
} from '@/features/plugins/pluginDeviceAutoSync'
import { reconcilePluginInstallation } from '@/features/plugins/pluginInstallTelemetry'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'
import type { useTranslation } from '@/hooks/useTranslation'
import type { PluginOperationNoticeState } from '../PluginOperationNotice'
import { pluginOperationNoticeAutoDismissDelay } from '../pluginOperationNoticePolicy'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { derivePluginMarketplaceCatalog } from '../pluginMarketplaceCatalog'
import { mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'
import {
  mergeWarmMarketplaceItems,
  mergeWarmMarketplaceOptions,
  rememberedMarketplaceKey,
  toInstalledPluginItem,
  isCodexCatalogItem,
  CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS,
  type MarketplaceOption,
  type PluginMarketplaceState,
} from './marketplaceWorkspaceHelpers'
import { loadPluginCatalog } from './pluginCatalogRead'
import { updatePluginCatalogDevice } from './pluginCatalogDeviceUpdate'
import { reconcilePluginCatalogDeviceReceipt } from './pluginCatalogDeviceReceipt'
import { reconcileLocalPluginCatalog } from './pluginCatalogLocalReconcile'
import { applyLocalPluginCatalogOptions } from './pluginCatalogApplyLocal'
import { applyLivePluginCatalog } from './pluginCatalogApplyLive'
import {
  readPersonalMarketplaceForCloudRefresh,
  mergeCloudMarketplaceRefresh,
} from './pluginCatalogRefresh'
import { pluginInventoryReadIsCurrent } from '@/features/plugins/pluginInventory'

export interface PluginCatalogInput {
  pluginApi: ReturnType<typeof createLocalDevicePluginApi>
  localPluginApi: ReturnType<typeof createLocalCodexPluginApi>
  cloudMarketplaceAvailable: boolean
  recoveryScopeKey?: string
  cloudToken: string | null | undefined
  knownExecutorDeviceId: string
  t: ReturnType<typeof useTranslation>['t']
  deviceCloudConnected: boolean
  pluginMutationInFlight: boolean
  isReconcilingPlugins: boolean
  installingMarketplacePluginIds: Set<string | number>
  pendingLocalConnectorAuth: {
    purpose: 'install' | 'manage'
    target: LocalConnectorAuthTarget
  } | null
}
export interface PluginCatalogSnapshot {
  installedPlugins: InstalledPluginItem[]
  marketplaceCatalogState: PluginMarketplaceState
  pluginMarketplaceState: PluginMarketplaceState
  currentDeviceId: string
  marketplaces: MarketplaceOption[]
  selectedMarketplaceKey: string
  inventoryComplete: boolean
  localInstalledStateReadyKey: string | null
  catalogReadReadyKey: string | null
  personalDiskSettledKey: string | null
  isMarketplaceRefreshing: boolean
  marketplaceLoadingMessage: string
  deviceAutoSyncSettled: boolean
  marketplaceRefreshTick: number
  pluginOperationNotice: PluginOperationNoticeState | null
  reconciliationScope: { accountKey: string; deviceId: string }
  reconciliationRequest: number
}
export interface PluginCatalogContext {
  readonly key: string
  readonly input: PluginCatalogInput
  readonly state: PluginCatalogSnapshot
  readonly catalog: PluginMarketplaceState
  readonly epoch: symbol | null
  readonly pendingDevicePackageSync: boolean
  ledger: {
    cloudMembershipAuthoritative: boolean
    lastMarketplaceRefreshTick: number
    deferredCodexCatalogRequest: string
    skipLocalCatalogReconcile: boolean
    autoUpdateAttemptKeys: Set<string>
    deviceStatusReportFailureCounts: Map<string, number>
    deviceStatusReportRetryTimer: number | null
    manualReconciliationTick: {
      tick: number
      accountKey: string
      deviceId: string
      isCurrent(): boolean
    } | null
  }
  publish(patch: Partial<PluginCatalogSnapshot>): void
  applyLocalMarketplaceState(
    state: Awaited<ReturnType<PluginCatalogInput['localPluginApi']['readState']>>
  ): void
  applyLiveCodexCatalog(
    state: Awaited<ReturnType<PluginCatalogInput['localPluginApi']['readState']>>
  ): void
}

/** Owns the live inventory, source completeness and device ACK/repair transactions. */
export function createPluginCatalogState(key: string, initial: PluginCatalogInput) {
  let input = initial
  const device = initial.knownExecutorDeviceId
  const account = getPluginMarketplaceCache(key)
  const cached = device && account?.deviceId !== device ? null : account
  const peek = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
  const local = device && peek?.deviceId !== device ? null : peek
  const installed = (cached?.installedPlugins ?? []).map(toInstalledPluginItem)
  const warm = mergeWarmMarketplaceItems(cached, local)
  const items = mergeMarketplaceCatalog(
    warm.filter(item => !isCodexCatalogItem(item)),
    warm.filter(isCodexCatalogItem),
    installed.map(item => item.raw)
  )
  const currentDeviceId = device || cached?.deviceId || local?.deviceId || ''
  const catalog = { items, isLoading: items.length === 0, error: null }
  let state: PluginCatalogSnapshot = {
    installedPlugins: installed,
    marketplaceCatalogState: catalog,
    pluginMarketplaceState: derivePluginMarketplaceCatalog(catalog, installed),
    currentDeviceId,
    marketplaces: mergeWarmMarketplaceOptions(
      cached,
      local,
      initial.cloudMarketplaceAvailable,
      initial.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
    ),
    selectedMarketplaceKey: cached?.selectedMarketplaceKey || rememberedMarketplaceKey(),
    inventoryComplete: false,
    localInstalledStateReadyKey: null,
    catalogReadReadyKey: null,
    personalDiskSettledKey: null,
    isMarketplaceRefreshing: false,
    marketplaceLoadingMessage: '',
    deviceAutoSyncSettled: hasSettledPluginDeviceAutoSync(currentDeviceId),
    marketplaceRefreshTick: 0,
    pluginOperationNotice: null,
    reconciliationScope: { accountKey: '', deviceId: '' },
    reconciliationRequest: 0,
  }
  const listeners = new Set<() => void>()
  let epoch: symbol | null = null
  let stopCache: (() => void) | undefined
  let stopRecovery: (() => void) | undefined
  let stopDevice: (() => void) | undefined
  let stopRead: (() => void) | undefined
  let stopLocal: (() => void) | undefined
  let localRequestKey = ''
  let cloudTimer: ReturnType<typeof setInterval> | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false
  let requestedTick = -1
  const recovery = createPluginRecoveryNotice({
    scopeKey: () => input.recoveryScopeKey ?? key,
    readNotice: () => state.pluginOperationNotice,
    showNotice: pluginOperationNotice => publish({ pluginOperationNotice }),
    t: message => input.t(message),
  })
  const captureScope = () => {
    const owner = epoch
    return () =>
      owner !== null &&
      epoch === owner &&
      listeners.size > 0 &&
      (!device || getKnownLocalExecutorDeviceId() === device)
  }
  const schedule = () => {
    if (scheduled || !listeners.size) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!listeners.size || context.epoch === null) return
      if (requestedTick !== state.marketplaceRefreshTick) {
        stopRead?.()
        stopLocal?.()
        stopLocal = undefined
        localRequestKey = ''
        requestedTick = state.marketplaceRefreshTick
        stopRead = loadPluginCatalog(context)
      }
      updatePluginCatalogDevice(context)
      reconcilePluginCatalogDeviceReceipt(context)
      const requestKey = `${state.catalogReadReadyKey}:${state.personalDiskSettledKey}:${state.marketplaceRefreshTick}`
      if (localRequestKey && localRequestKey !== requestKey) {
        stopLocal?.()
        stopLocal = undefined
        localRequestKey = ''
      }
      if (!localRequestKey) {
        const stop = reconcileLocalPluginCatalog(context)
        if (stop) {
          stopLocal = stop
          localRequestKey = requestKey
        }
      }
    })
  }
  const publish = (patch: Partial<PluginCatalogSnapshot>) => {
    if (!listeners.size) return
    if (
      Object.entries(patch).every(
        ([field, value]) => state[field as keyof PluginCatalogSnapshot] === value
      )
    )
      return
    const previous = state
    state = { ...state, ...patch }
    if (
      previous.marketplaceCatalogState !== state.marketplaceCatalogState ||
      previous.installedPlugins !== state.installedPlugins
    )
      state.pluginMarketplaceState = derivePluginMarketplaceCatalog(
        state.marketplaceCatalogState,
        state.installedPlugins
      )
    if (previous.currentDeviceId !== state.currentDeviceId)
      state.deviceAutoSyncSettled = hasSettledPluginDeviceAutoSync(state.currentDeviceId)
    if (
      previous.installedPlugins !== state.installedPlugins ||
      previous.currentDeviceId !== state.currentDeviceId
    ) {
      for (const plugin of state.installedPlugins)
        reconcilePluginInstallation(plugin.raw, state.currentDeviceId)
    }
    if (previous.pluginOperationNotice !== state.pluginOperationNotice) {
      scheduleNotice()
      recovery.reconcile()
    }
    listeners.forEach(listener => listener())
    schedule()
  }
  const scheduleNotice = () => {
    clearTimeout(noticeTimer)
    const delay = pluginOperationNoticeAutoDismissDelay(state.pluginOperationNotice)
    const notice = state.pluginOperationNotice
    const isCurrent = captureScope()
    if (delay !== null && notice)
      noticeTimer = setTimeout(() => {
        if (isCurrent() && state.pluginOperationNotice === notice)
          publish({ pluginOperationNotice: null })
      }, delay)
  }
  const context: PluginCatalogContext = {
    key,
    get input() {
      return input
    },
    get state() {
      return state
    },
    get catalog() {
      return state.pluginMarketplaceState
    },
    get epoch() {
      return listeners.size && (!device || getKnownLocalExecutorDeviceId() === device)
        ? epoch
        : null
    },
    get pendingDevicePackageSync() {
      return (
        state.inventoryComplete &&
        input.cloudMarketplaceAvailable &&
        Boolean(input.cloudToken) &&
        Boolean(state.currentDeviceId) &&
        input.deviceCloudConnected &&
        marketplaceNeedsDeviceSync(state.pluginMarketplaceState.items) &&
        !state.deviceAutoSyncSettled
      )
    },
    ledger: {
      cloudMembershipAuthoritative: false,
      lastMarketplaceRefreshTick: 0,
      deferredCodexCatalogRequest: '',
      skipLocalCatalogReconcile: false,
      autoUpdateAttemptKeys: new Set(),
      deviceStatusReportFailureCounts: new Map(),
      deviceStatusReportRetryTimer: null,
      manualReconciliationTick: null,
    },
    publish,
    applyLocalMarketplaceState: value => applyLocalPluginCatalogOptions(context, value),
    applyLiveCodexCatalog: value => applyLivePluginCatalog(context, value),
  }
  const refresh = (manual: boolean, reloadLocal = true) => {
    if (!listeners.size) return
    if (manual) {
      const prefix = `${key}:${state.currentDeviceId}:`
      for (const attempt of context.ledger.autoUpdateAttemptKeys)
        if (attempt.startsWith(prefix)) context.ledger.autoUpdateAttemptKeys.delete(attempt)
      clearLocalCodexPluginsReadStateCache()
      context.ledger.manualReconciliationTick = {
        tick: state.marketplaceRefreshTick + 1,
        accountKey: key,
        deviceId: state.currentDeviceId,
        isCurrent: captureScope(),
      }
    }
    context.ledger.skipLocalCatalogReconcile = !reloadLocal
    stopRead?.()
    stopLocal?.()
    stopLocal = undefined
    localRequestKey = ''
    publish({ marketplaceRefreshTick: state.marketplaceRefreshTick + 1 })
    requestedTick = state.marketplaceRefreshTick
    stopRead = loadPluginCatalog(context)
  }
  const revalidateCloud = () => {
    if (!input.cloudMarketplaceAvailable || !listeners.size) return
    const isCurrent = captureScope()
    const inventory = getPluginMarketplaceCache(key)
    void Promise.all([
      input.pluginApi.listMarketplacePlugins({ deviceId: state.currentDeviceId || undefined }),
      readPersonalMarketplaceForCloudRefresh(),
    ])
      .then(([response, personal]) => {
        if (!isCurrent() || !pluginInventoryReadIsCurrent(key, inventory)) return
        const items = mergeCloudMarketplaceRefresh(
          state.pluginMarketplaceState.items,
          response.items,
          state.installedPlugins.map(item => item.raw),
          personal
        )
        const cached = getPluginMarketplaceCache(key)
        if (cached)
          setPluginMarketplaceCache({ ...cached, marketplaceItems: items, fetchedAt: Date.now() })
        if (!sameMarketplaceItems(state.marketplaceCatalogState.items, items))
          publish({
            marketplaceCatalogState: { ...state.marketplaceCatalogState, items, error: null },
          })
      })
      .catch(() => undefined)
  }
  return {
    getSnapshot: () => state,
    subscribe(next: PluginCatalogInput, listener: () => void) {
      const previousInput = input
      input = next
      const first = listeners.size === 0
      listeners.add(listener)
      if (epoch === null) {
        epoch = Symbol('plugin-catalog-account-device')
        stopCache = subscribePluginMarketplaceCache(snapshot => {
          if (!snapshot || snapshot.cacheKey !== key || (device && snapshot.deviceId !== device))
            return
          const installed = snapshot.installedPlugins.map(toInstalledPluginItem)
          const items = snapshot.marketplaceItems
          const rejected = Object.values(snapshot.localInstalledSourceStatus ?? {}).includes(
            'rejected'
          )
          const isLoading = state.marketplaceCatalogState.isLoading && items.length === 0
          publish({
            ...(rejected ? { inventoryComplete: false, localInstalledStateReadyKey: null } : {}),
            ...(sameInstalledPlugins(state.installedPlugins, installed)
              ? {}
              : { installedPlugins: installed }),
            ...(sameMarketplaceItems(state.marketplaceCatalogState.items, items) &&
            state.marketplaceCatalogState.isLoading === isLoading
              ? {}
              : {
                  marketplaceCatalogState: { ...state.marketplaceCatalogState, items, isLoading },
                }),
          })
        })
        stopRecovery = recovery.subscribe()
        stopDevice = subscribePluginDeviceSync(schedule)
        requestedTick = state.marketplaceRefreshTick
        stopRead = loadPluginCatalog(context)
        scheduleNotice()
      } else if (
        previousInput.cloudMarketplaceAvailable !== input.cloudMarketplaceAvailable ||
        previousInput.pluginApi !== input.pluginApi ||
        previousInput.localPluginApi !== input.localPluginApi
      ) {
        stopRead?.()
        stopLocal?.()
        stopLocal = undefined
        localRequestKey = ''
        context.ledger.deferredCodexCatalogRequest = ''
        const cached = getPluginMarketplaceCache(key)
        const peek = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
        const matchingPeek = device && peek?.deviceId !== device ? null : peek
        const options = mergeWarmMarketplaceOptions(
          cached,
          matchingPeek,
          input.cloudMarketplaceAvailable,
          input.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
        )
        publish({ marketplaces: options })
        stopRead = loadPluginCatalog(context)
      }
      if (input.cloudMarketplaceAvailable && cloudTimer === undefined)
        cloudTimer = setInterval(revalidateCloud, CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS)
      if (!input.cloudMarketplaceAvailable) {
        clearInterval(cloudTimer)
        cloudTimer = undefined
      }
      if (
        input.deviceCloudConnected &&
        state.pluginOperationNotice?.id.startsWith('install-device-disconnected-')
      )
        publish({ pluginOperationNotice: null })
      if (first)
        for (const plugin of state.installedPlugins)
          reconcilePluginInstallation(plugin.raw, state.currentDeviceId)
      schedule()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          epoch = null
          stopRead?.()
          stopLocal?.()
          stopCache?.()
          stopDevice?.()
          stopRecovery?.()
          stopRecovery = undefined
          stopRead = undefined
          stopLocal = undefined
          stopCache = undefined
          stopDevice = undefined
          localRequestKey = ''
          context.ledger.deferredCodexCatalogRequest = ''
          clearInterval(cloudTimer)
          cloudTimer = undefined
          clearTimeout(noticeTimer)
          noticeTimer = undefined
          if (context.ledger.deviceStatusReportRetryTimer !== null)
            window.clearTimeout(context.ledger.deviceStatusReportRetryTimer)
          context.ledger.deviceStatusReportRetryTimer = null
        })
      }
    },
    captureScope,
    refresh,
    revalidateCloud,
    selectMarketplace(selectedMarketplaceKey: string) {
      publish({ selectedMarketplaceKey })
    },
    rememberDevice(currentDeviceId: string) {
      publish({ currentDeviceId })
    },
    includeMarketplaceItem(item: PluginMarketplaceItem) {
      publish({
        marketplaceCatalogState: {
          ...state.marketplaceCatalogState,
          items: [
            item,
            ...state.marketplaceCatalogState.items.filter(candidate => candidate.id !== item.id),
          ],
        },
      })
    },
    restoreMarketplaceItem(item: PluginMarketplaceItem) {
      publish({
        marketplaceCatalogState: {
          ...state.marketplaceCatalogState,
          error: null,
          items: state.marketplaceCatalogState.items.map(candidate =>
            candidate.id === item.id ? item : candidate
          ),
        },
      })
    },
    acceptLocalMarketplaces: context.applyLocalMarketplaceState,
    applyMarketplaceAccess(id: string | number, access: PluginAccessResponse) {
      publish({
        marketplaceCatalogState: {
          ...state.marketplaceCatalogState,
          items: state.marketplaceCatalogState.items.map(item =>
            item.id === id
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
          ),
        },
      })
    },
    previewComponentState(id: string | number, componentKey: string, enabled: boolean) {
      publish({
        installedPlugins: state.installedPlugins.map(item =>
          item.id === id
            ? {
                ...item,
                raw: {
                  ...item.raw,
                  spec: {
                    ...item.raw.spec,
                    componentStates: { ...item.raw.spec.componentStates, [componentKey]: enabled },
                  },
                },
              }
            : item
        ),
      })
    },
    restoreComponentState(
      id: string | number,
      previous: Record<string, boolean>,
      componentKey: string
    ) {
      publish({
        installedPlugins: state.installedPlugins.map(item =>
          item.id === id
            ? {
                ...item,
                raw: {
                  ...item.raw,
                  spec: {
                    ...item.raw.spec,
                    componentStates: restorePluginComponentState(
                      item.raw.spec.componentStates,
                      previous,
                      componentKey
                    ),
                  },
                },
              }
            : item
        ),
      })
    },
    showPendingRecovery: recovery.showPending,
    reportLocalProgress: recovery.reportProgress,
    dismissNotice(id: string) {
      if (state.pluginOperationNotice?.id === id) publish({ pluginOperationNotice: null })
    },
    reportError(error: string | null) {
      publish({ marketplaceCatalogState: { ...state.marketplaceCatalogState, error } })
    },
    showNotice(pluginOperationNotice: PluginOperationNoticeState | null) {
      publish({ pluginOperationNotice })
    },
    markReconciled() {
      if (!listeners.size || context.epoch === null) return
      markPluginDeviceAutoSyncSettled(state.currentDeviceId)
      publish({ deviceAutoSyncSettled: true })
    },
  }
}
