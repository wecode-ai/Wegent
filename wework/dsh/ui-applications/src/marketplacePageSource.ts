import type { SetStateAction } from 'react'
import type { SmartAppsApi, SmartAppMarketplaceItem } from '@/api/smartApps'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { useHarnessAppManagement } from '@/features/harness-apps/useHarnessAppManagement'
import type { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
import type {
  PendingInstall,
  SelectedSmartApp,
  OwnedFilter,
  MarketplaceSort,
} from './smartAppsMarketplaceTypes'
export interface MarketplacePageSnapshot {
  marketplaceSort: MarketplaceSort
  ownedFilter: OwnedFilter
  busy: string | null
  exportNotice: string | null
  accessNotice: {
    message: string
    showMarketplace: boolean
  } | null
  selected: SelectedSmartApp | null
  pendingInstall: PendingInstall | null
  modelKey: string
  publishItem: SmartAppMarketplaceItem | null | undefined
  publishInstallation: HarnessAppInstallation | null
  publishRequestHandled: boolean
  shareItem: SmartAppMarketplaceItem | null
  creating: boolean
  createError: string | null
  developmentDialog: 'create' | 'copy' | null
  copyInstallation: HarnessAppInstallation | null
  importing: boolean
  pendingDelete: HarnessAppInstallation | null
  pluginInstallation: HarnessAppInstallation | null
  targetInstallItem: SmartAppMarketplaceItem | null
  targetLookupError: string | null
  targetLookupPending: boolean
  targetLookupRevision: number
}
function initialSnapshot(): MarketplacePageSnapshot {
  return {
    marketplaceSort: 'recommended',
    ownedFilter: 'all',
    busy: null,
    exportNotice: null,
    accessNotice: null,
    selected: null,
    pendingInstall: null,
    modelKey: '',
    publishItem: undefined,
    publishInstallation: null,
    publishRequestHandled: false,
    shareItem: null,
    creating: false,
    createError: null,
    developmentDialog: null,
    copyInstallation: null,
    importing: false,
    pendingDelete: null,
    pluginInstallation: null,
    targetInstallItem: null,
    targetLookupError: null,
    targetLookupPending: false,
    targetLookupRevision: 0,
  }
}
interface MarketplaceOwner {
  api: SmartAppsApi | null
  targetSmartAppId: number | null
}
export interface MarketplacePageInput extends MarketplaceOwner {
  activeInstallations: HarnessAppInstallation[]
  items: SmartAppMarketplaceItem[]
  readLocalInstallations: PendingInstall['readInstallations']
  modelOptions: ReturnType<typeof useHarnessAppManagement>['modelOptions']
  hasSelectedModel: ReturnType<typeof useHarnessAppManagement>['hasSelectedModel']
  openInstalledApp: ReturnType<typeof useHarnessAppManagement>['open']
  startInstalledApp: ReturnType<typeof useHarnessAppManagement>['start']
  t: ReturnType<typeof useTranslation>['t']
  mode: 'marketplace' | 'owned'
}
/** The active marketplace API/target owns selection, preparation and navigation receipts. */
export function createMarketplacePageSource() {
  let snapshot = initialSnapshot()
  let owner: MarketplaceOwner | null = null
  let input: MarketplacePageInput | null = null
  let generation = 0
  let suspended = false
  const listeners = new Set<() => void>()
  let previousTargetId: number | null = null
  let openedTargetId: number | null = null
  let catalogTargetId: number | null = null
  let targetApi: SmartAppsApi | null = null
  let targetCatalogItems: SmartAppMarketplaceItem[] | null = null
  let failedTargetId: number | null = null
  let pendingLookup: { target: number; api: SmartAppsApi } | null = null
  let lookupRevision: number = 0
  let lookupRequest: number = 0
  let dismissedTargetId: number | null = null
  let downloadRequest: number = 0
  let installRequest: number = 0
  const publish = (next: MarketplacePageSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  function update<K extends keyof MarketplacePageSnapshot>(
    key: K,
    value: MarketplacePageSnapshot[K]
  ) {
    if (!listeners.size || snapshot[key] === value) return
    publish({ ...snapshot, [key]: value })
  }

  function setMarketplaceSort(value: SetStateAction<MarketplacePageSnapshot['marketplaceSort']>) {
    update('marketplaceSort', typeof value === 'function' ? value(snapshot.marketplaceSort) : value)
  }
  function setOwnedFilter(value: SetStateAction<MarketplacePageSnapshot['ownedFilter']>) {
    update('ownedFilter', typeof value === 'function' ? value(snapshot.ownedFilter) : value)
  }
  function setBusy(value: SetStateAction<MarketplacePageSnapshot['busy']>) {
    update('busy', typeof value === 'function' ? value(snapshot.busy) : value)
  }
  function setExportNotice(value: SetStateAction<MarketplacePageSnapshot['exportNotice']>) {
    update('exportNotice', typeof value === 'function' ? value(snapshot.exportNotice) : value)
  }
  function setAccessNotice(value: SetStateAction<MarketplacePageSnapshot['accessNotice']>) {
    update('accessNotice', typeof value === 'function' ? value(snapshot.accessNotice) : value)
  }
  function setSelected(value: SetStateAction<MarketplacePageSnapshot['selected']>) {
    update('selected', typeof value === 'function' ? value(snapshot.selected) : value)
  }
  function setPendingInstall(value: SetStateAction<MarketplacePageSnapshot['pendingInstall']>) {
    update('pendingInstall', typeof value === 'function' ? value(snapshot.pendingInstall) : value)
  }
  function setModelKey(value: SetStateAction<MarketplacePageSnapshot['modelKey']>) {
    update('modelKey', typeof value === 'function' ? value(snapshot.modelKey) : value)
  }
  function setPublishItem(value: SetStateAction<MarketplacePageSnapshot['publishItem']>) {
    update('publishItem', typeof value === 'function' ? value(snapshot.publishItem) : value)
  }
  function setPublishInstallation(
    value: SetStateAction<MarketplacePageSnapshot['publishInstallation']>
  ) {
    update(
      'publishInstallation',
      typeof value === 'function' ? value(snapshot.publishInstallation) : value
    )
  }
  function setPublishRequestHandled(
    value: SetStateAction<MarketplacePageSnapshot['publishRequestHandled']>
  ) {
    update(
      'publishRequestHandled',
      typeof value === 'function' ? value(snapshot.publishRequestHandled) : value
    )
  }
  function setShareItem(value: SetStateAction<MarketplacePageSnapshot['shareItem']>) {
    update('shareItem', typeof value === 'function' ? value(snapshot.shareItem) : value)
  }
  function setCreating(value: SetStateAction<MarketplacePageSnapshot['creating']>) {
    update('creating', typeof value === 'function' ? value(snapshot.creating) : value)
  }
  function setCreateError(value: SetStateAction<MarketplacePageSnapshot['createError']>) {
    update('createError', typeof value === 'function' ? value(snapshot.createError) : value)
  }
  function setDevelopmentDialog(
    value: SetStateAction<MarketplacePageSnapshot['developmentDialog']>
  ) {
    update(
      'developmentDialog',
      typeof value === 'function' ? value(snapshot.developmentDialog) : value
    )
  }
  function setCopyInstallation(value: SetStateAction<MarketplacePageSnapshot['copyInstallation']>) {
    update(
      'copyInstallation',
      typeof value === 'function' ? value(snapshot.copyInstallation) : value
    )
  }
  function setImporting(value: SetStateAction<MarketplacePageSnapshot['importing']>) {
    update('importing', typeof value === 'function' ? value(snapshot.importing) : value)
  }
  function setPendingDelete(value: SetStateAction<MarketplacePageSnapshot['pendingDelete']>) {
    update('pendingDelete', typeof value === 'function' ? value(snapshot.pendingDelete) : value)
  }
  function setPluginInstallation(
    value: SetStateAction<MarketplacePageSnapshot['pluginInstallation']>
  ) {
    update(
      'pluginInstallation',
      typeof value === 'function' ? value(snapshot.pluginInstallation) : value
    )
  }
  function setTargetInstallItem(
    value: SetStateAction<MarketplacePageSnapshot['targetInstallItem']>
  ) {
    update(
      'targetInstallItem',
      typeof value === 'function' ? value(snapshot.targetInstallItem) : value
    )
  }
  function setTargetLookupError(
    value: SetStateAction<MarketplacePageSnapshot['targetLookupError']>
  ) {
    update(
      'targetLookupError',
      typeof value === 'function' ? value(snapshot.targetLookupError) : value
    )
  }
  function setTargetLookupPending(
    value: SetStateAction<MarketplacePageSnapshot['targetLookupPending']>
  ) {
    update(
      'targetLookupPending',
      typeof value === 'function' ? value(snapshot.targetLookupPending) : value
    )
  }
  function setTargetLookupRevision(
    value: SetStateAction<MarketplacePageSnapshot['targetLookupRevision']>
  ) {
    update(
      'targetLookupRevision',
      typeof value === 'function' ? value(snapshot.targetLookupRevision) : value
    )
  }
  function scheduleTarget(action: () => void) {
    const version = generation,
      request = lookupRequest
    queueMicrotask(() => {
      if (listeners.size && version === generation && request === lookupRequest) action()
    })
  }
  function selectResolvedItem(item: SmartAppMarketplaceItem) {
    if (!input || !listeners.size) return
    setSelected({ item, readInstallations: input.readLocalInstallations })
  }
  function reconcile() {
    if (!input || !listeners.size) return
    const {
      api,
      targetSmartAppId,
      activeInstallations,
      items,
      hasSelectedModel,
      openInstalledApp,
      startInstalledApp,
      t,
    } = input
    const { targetLookupRevision } = snapshot
    if (!targetSmartAppId) return
    if (previousTargetId !== targetSmartAppId) {
      previousTargetId = targetSmartAppId
      openedTargetId = null
      catalogTargetId = null
      targetApi = api
      targetCatalogItems = null
      failedTargetId = null
      pendingLookup = null
      dismissedTargetId = null
      lookupRevision = targetLookupRevision
      lookupRequest += 1
      downloadRequest += 1
      installRequest += 1
      scheduleTarget(() => {
        setSelected(null)
        setPendingInstall(null)
        setModelKey('')
        setBusy(current =>
          current === 'install' || current?.startsWith('download-') ? null : current
        )
        setTargetInstallItem(null)
        setTargetLookupError(null)
        setTargetLookupPending(false)
      })
    }
    if (targetApi !== api) {
      targetApi = api
      catalogTargetId = null
      targetCatalogItems = null
      failedTargetId = null
      pendingLookup = null
      lookupRevision = targetLookupRevision
      lookupRequest += 1
      scheduleTarget(() => {
        setSelected(null)
        setTargetInstallItem(null)
        setTargetLookupError(null)
        setTargetLookupPending(false)
      })
    }
    const installation = activeInstallations.find(
      candidate => candidate.smartAppId === targetSmartAppId
    )
    if (installation && (installation.state !== 'running' || installation.webUrl)) {
      const shouldOpen = openedTargetId !== targetSmartAppId
      pendingLookup = null
      lookupRequest += 1
      scheduleTarget(() => {
        setTargetInstallItem(null)
        setTargetLookupError(null)
        setTargetLookupPending(false)
        if (!shouldOpen || openedTargetId === targetSmartAppId) return
        if (installation.state === 'running' || hasSelectedModel(installation))
          openedTargetId = targetSmartAppId
        if (installation.state === 'running') openInstalledApp(installation)
        else startInstalledApp(installation)
      })
      return
    }
    if (installation) {
      openedTargetId = null
      pendingLookup = null
      lookupRequest += 1
      scheduleTarget(() => {
        setSelected(null)
        setTargetInstallItem(null)
        setTargetLookupError(null)
        setTargetLookupPending(true)
      })
      return
    }
    openedTargetId = null
    if (!api) return
    const currentApiItems = items
    const catalogRefreshed = currentApiItems !== null && currentApiItems !== targetCatalogItems
    const retryRequested = lookupRevision !== targetLookupRevision
    if (retryRequested) {
      lookupRevision = targetLookupRevision
      failedTargetId = null
      pendingLookup = null
      dismissedTargetId = null
    }
    const item = currentApiItems?.find(candidate => candidate.id === targetSmartAppId)
    if (item) {
      catalogTargetId = targetSmartAppId
      targetCatalogItems = currentApiItems
      failedTargetId = null
      pendingLookup = null
      lookupRequest += 1
      scheduleTarget(() => {
        setTargetInstallItem(item)
        setTargetLookupError(null)
        setTargetLookupPending(false)
        if (dismissedTargetId !== targetSmartAppId) {
          selectResolvedItem(item)
        }
      })
      return
    }
    if (catalogTargetId === targetSmartAppId) {
      if (targetCatalogItems === null || !catalogRefreshed) {
        if (failedTargetId !== targetSmartAppId || !retryRequested) return
      }
      catalogTargetId = null
      targetCatalogItems = null
      pendingLookup = null
      setTargetInstallItem(null)
      setSelected(null)
    }
    if (failedTargetId === targetSmartAppId && !retryRequested) return
    const inFlight = pendingLookup
    if (inFlight?.target === targetSmartAppId && inFlight.api === api) return
    const requestId = ++lookupRequest
    pendingLookup = { target: targetSmartAppId, api }
    scheduleTarget(() => {
      setTargetLookupPending(true)
      setTargetLookupError(null)
    })
    void api
      .getItem(targetSmartAppId)
      .then(item => {
        if (requestId !== lookupRequest) return
        catalogTargetId = targetSmartAppId
        targetCatalogItems = null
        failedTargetId = null
        setTargetInstallItem(item)
        setTargetLookupError(null)
        if (dismissedTargetId !== targetSmartAppId) {
          selectResolvedItem(item)
        }
      })
      .catch(error => {
        if (requestId !== lookupRequest) return
        failedTargetId = targetSmartAppId
        setTargetInstallItem(null)
        setTargetLookupError(
          getSmartAppErrorMessage(
            error,
            t(
              'workbench.smart_apps_deep_link_unavailable',
              '未找到此智能工作台，可能已下架或你没有访问权限。'
            ),
            t
          )
        )
      })
      .finally(() => {
        if (requestId === lookupRequest) {
          pendingLookup = null
          scheduleTarget(() => setTargetLookupPending(false))
        }
      })
  }
  function reconcilePublish() {
    if (!input || input.mode !== 'owned' || snapshot.publishRequestHandled) return
    const params = new URLSearchParams(window.location.search)
    const installationId = params.get('installationId')
    if (params.get('action') !== 'publish' || !installationId) return
    const installation = input.activeInstallations.find(item => item.id === installationId)
    if (!installation) return
    publish({
      ...snapshot,
      publishRequestHandled: true,
      publishInstallation: installation,
      publishItem: installation.smartAppId
        ? (input.items.find(item => item.id === installation.smartAppId) ?? null)
        : null,
    })
  }
  function project(next: MarketplaceOwner) {
    if (owner?.api === next.api && owner?.targetSmartAppId === next.targetSmartAppId)
      return snapshot
    const reset = initialSnapshot()
    const apiChanged = owner?.api !== next.api
    return {
      ...snapshot,
      ...(apiChanged
        ? {
            creating: false,
            importing: false,
            createError: null,
            exportNotice: null,
            accessNotice: null,
            publishRequestHandled: false,
            publishItem: reset.publishItem,
            publishInstallation: null,
            shareItem: null,
            developmentDialog: null,
            copyInstallation: null,
            pluginInstallation: null,
            pendingDelete: null,
          }
        : {}),
      selected: null,
      pendingInstall: null,
      modelKey: '',
      busy: null,
      targetInstallItem: null,
      targetLookupError: null,
      targetLookupPending: false,
    }
  }
  return {
    observe(next: MarketplaceOwner) {
      let base: MarketplacePageSnapshot | undefined, projected: MarketplacePageSnapshot
      const isCurrent = () => owner === next && listeners.size > 0
      const getSnapshot = () => {
        if (snapshot !== base) {
          base = snapshot
          projected = project(next)
        }
        return projected
      }
      return {
        getSnapshot,
        isCurrent,
        captureOwner() {
          const version = generation,
            catalogOwner = input?.readLocalInstallations
          return () =>
            isCurrent() && version === generation && catalogOwner === input?.readLocalInstallations
        },
        beginDownload() {
          const catalogOwner = input?.readLocalInstallations
          const version = generation,
            request = ++downloadRequest
          return () =>
            isCurrent() &&
            version === generation &&
            request === downloadRequest &&
            catalogOwner === input?.readLocalInstallations
        },
        beginInstall() {
          const catalogOwner = input?.readLocalInstallations
          const version = generation,
            request = ++installRequest
          return () =>
            isCurrent() &&
            version === generation &&
            request === installRequest &&
            catalogOwner === input?.readLocalInstallations
        },
        selectDetails(
          item: SmartAppMarketplaceItem,
          readInstallations: PendingInstall['readInstallations']
        ) {
          if (!isCurrent()) return
          if (item.id === next.targetSmartAppId) dismissedTargetId = null
          setSelected({ item, readInstallations })
        },
        closeDetails() {
          if (!isCurrent()) return
          if (next.targetSmartAppId) dismissedTargetId = next.targetSmartAppId
          setSelected(null)
        },
        retryTarget() {
          if (!isCurrent()) return
          setTargetLookupRevision(value => value + 1)
          reconcile()
        },

        setMarketplaceSort(value: SetStateAction<MarketplacePageSnapshot['marketplaceSort']>) {
          if (isCurrent()) setMarketplaceSort(value)
        },
        setOwnedFilter(value: SetStateAction<MarketplacePageSnapshot['ownedFilter']>) {
          if (isCurrent()) setOwnedFilter(value)
        },
        setBusy(value: SetStateAction<MarketplacePageSnapshot['busy']>) {
          if (isCurrent()) setBusy(value)
        },
        setExportNotice(value: SetStateAction<MarketplacePageSnapshot['exportNotice']>) {
          if (isCurrent()) setExportNotice(value)
        },
        setAccessNotice(value: SetStateAction<MarketplacePageSnapshot['accessNotice']>) {
          if (isCurrent()) setAccessNotice(value)
        },
        setSelected(value: SetStateAction<MarketplacePageSnapshot['selected']>) {
          if (isCurrent()) setSelected(value)
        },
        setPendingInstall(value: SetStateAction<MarketplacePageSnapshot['pendingInstall']>) {
          if (isCurrent()) setPendingInstall(value)
        },
        setModelKey(value: SetStateAction<MarketplacePageSnapshot['modelKey']>) {
          if (isCurrent()) setModelKey(value)
        },
        setPublishItem(value: SetStateAction<MarketplacePageSnapshot['publishItem']>) {
          if (isCurrent()) setPublishItem(value)
        },
        setPublishInstallation(
          value: SetStateAction<MarketplacePageSnapshot['publishInstallation']>
        ) {
          if (isCurrent()) setPublishInstallation(value)
        },
        setPublishRequestHandled(
          value: SetStateAction<MarketplacePageSnapshot['publishRequestHandled']>
        ) {
          if (isCurrent()) setPublishRequestHandled(value)
        },
        setShareItem(value: SetStateAction<MarketplacePageSnapshot['shareItem']>) {
          if (isCurrent()) setShareItem(value)
        },
        setCreating(value: SetStateAction<MarketplacePageSnapshot['creating']>) {
          if (isCurrent()) setCreating(value)
        },
        setCreateError(value: SetStateAction<MarketplacePageSnapshot['createError']>) {
          if (isCurrent()) setCreateError(value)
        },
        setDevelopmentDialog(value: SetStateAction<MarketplacePageSnapshot['developmentDialog']>) {
          if (isCurrent()) setDevelopmentDialog(value)
        },
        setCopyInstallation(value: SetStateAction<MarketplacePageSnapshot['copyInstallation']>) {
          if (isCurrent()) setCopyInstallation(value)
        },
        setImporting(value: SetStateAction<MarketplacePageSnapshot['importing']>) {
          if (isCurrent()) setImporting(value)
        },
        setPendingDelete(value: SetStateAction<MarketplacePageSnapshot['pendingDelete']>) {
          if (isCurrent()) setPendingDelete(value)
        },
        setPluginInstallation(
          value: SetStateAction<MarketplacePageSnapshot['pluginInstallation']>
        ) {
          if (isCurrent()) setPluginInstallation(value)
        },
        setTargetInstallItem(value: SetStateAction<MarketplacePageSnapshot['targetInstallItem']>) {
          if (isCurrent()) setTargetInstallItem(value)
        },
        setTargetLookupError(value: SetStateAction<MarketplacePageSnapshot['targetLookupError']>) {
          if (isCurrent()) setTargetLookupError(value)
        },
        setTargetLookupPending(
          value: SetStateAction<MarketplacePageSnapshot['targetLookupPending']>
        ) {
          if (isCurrent()) setTargetLookupPending(value)
        },
        setTargetLookupRevision(
          value: SetStateAction<MarketplacePageSnapshot['targetLookupRevision']>
        ) {
          if (isCurrent()) {
            setTargetLookupRevision(value)
            reconcile()
          }
        },
        subscribe(listener: () => void, value: MarketplacePageInput) {
          listeners.add(listener)
          if (owner !== next) {
            snapshot = project(next)
            if (!next.targetSmartAppId) {
              previousTargetId = null
              openedTargetId = null
              catalogTargetId = null
              targetApi = null
              targetCatalogItems = null
              failedTargetId = null
              pendingLookup = null
              dismissedTargetId = null
            }
            owner = next
            generation++
            downloadRequest++
            installRequest++
            lookupRequest++
          }
          const changed = input !== value || suspended
          suspended = false
          input = value
          if (changed) {
            reconcile()
            reconcilePublish()
          }
          return () => {
            listeners.delete(listener)
            queueMicrotask(() => {
              if (listeners.size) return
              suspended = true
              snapshot = {
                ...snapshot,
                busy: null,
                creating: false,
                importing: false,
                pendingInstall: null,
                modelKey: '',
                targetLookupPending: false,
              }
              pendingLookup = null
              generation++
              downloadRequest++
              installRequest++
              lookupRequest++
            })
          }
        },
      }
    },
  }
}
