import { createMarketplaceOperations } from './marketplaceOperations'
import { createMarketplacePageSource } from './marketplacePageSource'
import { useSyncExternalStore } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { useCallback, useMemo, useState } from 'react'
import type { SmartAppMarketplaceItem } from '@/api/smartApps'
import {
  HARNESS_APP_INSTALLATIONS_CHANGED_EVENT,
  type HarnessAppInstallationsChangedDetail,
} from '@/features/harness-apps/harnessAppInstallationsChanged'
import { useHarnessAppManagement } from '@/features/harness-apps/useHarnessAppManagement'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { useSmartAppCatalog } from './useSmartAppCatalog'
import type { SmartAppsMarketplacePageProps, OwnedSmartAppCard } from './smartAppsMarketplaceTypes'
// Keep completed local removals authoritative until the next installation event.
const locallyRemovedInstallationIds = new Set<string>()
export function useSmartAppsMarketplaceModel({
  api,
  mode = 'marketplace',
  onNavigate = navigateTo,
  targetSmartAppId = null,
}: SmartAppsMarketplacePageProps) {
  const { t, i18n } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'official' | 'public' | 'shared'>('all')
  const [tag, setTag] = useState('')
  const [pageSource] = useState(createMarketplacePageSource)
  const pageView = useMemo(
    () => pageSource.observe({ api, targetSmartAppId }),
    [pageSource, api, targetSmartAppId]
  )
  const {
    setMarketplaceSort,
    setOwnedFilter,
    setBusy,
    setExportNotice,
    setAccessNotice,
    setSelected,
    setPendingInstall,
    setModelKey,
    setPublishItem,
    setPublishInstallation,
    setPublishRequestHandled,
    setShareItem,
    setCreating,
    setCreateError,
    setDevelopmentDialog,
    setCopyInstallation,
    setImporting,
    setPendingDelete,
    setPluginInstallation,
    setTargetInstallItem,
    setTargetLookupError,
    setTargetLookupPending,
    setTargetLookupRevision,
  } = pageView
  const {
    items,
    marketItems,
    installed,
    localReady,
    localError,
    readLocalInstallations,
    tags,
    loading,
    error,
    loadError,
    refresh,
    invalidateRefresh,
    setError,
    setInstalled,
  } = useSmartAppCatalog({ api, mode, query, source, tag })
  const activeInstallations = useMemo(
    () => installed.filter(item => !locallyRemovedInstallationIds.has(item.id)),
    [installed]
  )
  const {
    changeModel,
    hasSelectedModel,
    modelOptions,
    open: openInstalledApp,
    start: startInstalledApp,
    stop: stopInstalledApp,
  } = useHarnessAppManagement({
    installations: activeInstallations,
    onBusyChange: setBusy,
    onError: setError,
    onRefresh: refresh,
  })
  const pageInput = useMemo(
    () => ({
      api,
      targetSmartAppId,
      activeInstallations,
      items,
      readLocalInstallations,
      hasSelectedModel,
      modelOptions,
      openInstalledApp,
      startInstalledApp,
      t,
      mode,
    }),
    [
      api,
      targetSmartAppId,
      activeInstallations,
      items,
      readLocalInstallations,
      hasSelectedModel,
      modelOptions,
      openInstalledApp,
      startInstalledApp,
      t,
      mode,
    ]
  )
  const pageState = useSyncExternalStore(
    listener => pageView.subscribe(listener, pageInput),
    pageView.getSnapshot,
    pageView.getSnapshot
  )
  const {
    marketplaceSort,
    ownedFilter,
    busy,
    exportNotice,
    accessNotice,
    selected,
    pendingInstall,
    modelKey,
    publishItem,
    publishInstallation,
    publishRequestHandled,
    shareItem,
    creating,
    createError,
    developmentDialog,
    copyInstallation,
    importing,
    pendingDelete,
    pluginInstallation,
    targetInstallItem,
    targetLookupError,
    targetLookupPending,
    targetLookupRevision,
  } = pageState
  const currentPendingInstall =
    pendingInstall?.readInstallations === readLocalInstallations ? pendingInstall : null
  const currentSelected =
    selected?.readInstallations === readLocalInstallations ? selected.item : null

  const navigateFromSmartApps = useCallback(
    (path: string) => {
      setAccessNotice(null)
      onNavigate(path)
    },
    [onNavigate, setAccessNotice]
  )

  const installModelKey = modelKey || modelOptions[0]?.key || ''
  const ownedCards = useMemo<OwnedSmartAppCard[]>(() => {
    return activeInstallations.map(installation => {
      const ownedItem = items.find(item =>
        installation.smartAppId != null
          ? item.id === installation.smartAppId
          : item.name === installation.manifest.name
      )
      const marketItem = installation.smartAppId
        ? marketItems.find(item => item.id === installation.smartAppId)
        : null
      return {
        category: (ownedItem || !installation.smartAppId
          ? 'created'
          : 'installed') as OwnedSmartAppCard['category'],
        installation,
        item: ownedItem ?? marketItem ?? null,
        key: `local-${installation.id}`,
      }
    })
  }, [activeInstallations, items, marketItems])
  const visibleOwnedCards = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return ownedCards.filter(card => {
      if (ownedFilter !== 'all' && card.category !== ownedFilter) return false
      if (!normalizedQuery) return true
      const title = card.item?.displayName ?? card.installation?.manifest.displayName ?? ''
      const description = card.item?.summary ?? card.installation?.manifest.description ?? ''
      return `${title} ${description}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [ownedCards, ownedFilter, query])
  const visibleMarketplaceItems = useMemo(
    () =>
      marketplaceSort === 'updated'
        ? [...items].sort(
            (left, right) =>
              new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
          )
        : items,
    [items, marketplaceSort]
  )
  const hasItems = mode === 'owned' ? visibleOwnedCards.length > 0 : items.length > 0

  const syncLocalInstallationChange = (
    event: CustomEvent<HarnessAppInstallationsChangedDetail>
  ) => {
    const detail = (event as CustomEvent<HarnessAppInstallationsChangedDetail>).detail
    if (detail.type === 'removed') {
      locallyRemovedInstallationIds.add(detail.installationId)
      setInstalled(current => current.filter(item => item.id !== detail.installationId))
      return
    }
    if (detail.type === 'stopped') {
      setInstalled(current =>
        current.map(item =>
          item.id === detail.installationId
            ? { ...item, state: 'installed', webUrl: null, error: null }
            : item
        )
      )
      return
    }

    locallyRemovedInstallationIds.delete(detail.installationId)
    setInstalled(current => [
      ...current.filter(item => item.id !== detail.installationId),
      detail.installation,
    ])
  }
  useDOMEvent<CustomEvent<HarnessAppInstallationsChangedDetail>>(
    'window',
    HARNESS_APP_INSTALLATIONS_CHANGED_EVENT,
    syncLocalInstallationChange
  )
  function localState(item: SmartAppMarketplaceItem) {
    const installation = activeInstallations.find(candidate => candidate.smartAppId === item.id)
    if (!installation) return null
    return {
      installation,
      update: installation.releaseId !== item.latestReleaseId,
    }
  }

  function selectDetails(item: SmartAppMarketplaceItem) {
    pageView.selectDetails(item, readLocalInstallations)
  }
  const closeDetails = pageView.closeDetails
  const operations = createMarketplaceOperations({
    pageView,
    pageState,
    catalog: {
      refresh,
      invalidateRefresh,
      readLocalInstallations,
      marketItems,
      setError,
      localReady,
    },
    management: { stop: stopInstalledApp },
    t,
    api,
    mode,
    currentPendingInstall,
    installModelKey,
    navigateFromSmartApps,
  })
  const {
    currentInstallation,
    requireCurrentInstallation,
    withCurrentInstallation,
    download,
    install,
    openBuilder,
    addPluginToInstallation,
    createSmartApp,
    copySmartApp,
    linkSmartAppDirectory,
    importCreatedPackage,
    chooseCreatedPackage,
    dropCreatedPackage,
    availableUpdate,
    runtimeStateLabel,
    focusModelSelector,
    exportInstallation,
    verifyInstallation,
    localActions,
    deleteLocalInstallation,
  } = operations
  return {
    api,
    mode,
    onNavigate,
    targetSmartAppId,
    t,
    i18n,
    query,
    setQuery,
    source,
    setSource,
    tag,
    setTag,
    marketplaceSort,
    setMarketplaceSort,
    ownedFilter,
    setOwnedFilter,
    busy,
    setBusy,
    exportNotice,
    setExportNotice,
    accessNotice,
    setAccessNotice,
    selected,
    setSelected,
    pendingInstall,
    setPendingInstall,
    modelKey,
    setModelKey,
    publishItem,
    setPublishItem,
    publishInstallation,
    setPublishInstallation,
    publishRequestHandled,
    setPublishRequestHandled,
    shareItem,
    setShareItem,
    creating,
    setCreating,
    createError,
    setCreateError,
    developmentDialog,
    setDevelopmentDialog,
    copyInstallation,
    setCopyInstallation,
    importing,
    setImporting,
    pendingDelete,
    setPendingDelete,
    pluginInstallation,
    setPluginInstallation,
    targetInstallItem,
    setTargetInstallItem,
    targetLookupError,
    setTargetLookupError,
    targetLookupPending,
    setTargetLookupPending,
    targetLookupRevision,
    setTargetLookupRevision,
    items,
    marketItems,
    installed,
    localReady,
    localError,
    readLocalInstallations,
    tags,
    loading,
    error,
    loadError,
    refresh,
    invalidateRefresh,
    setError,
    setInstalled,
    currentPendingInstall,
    currentSelected,
    navigateFromSmartApps,
    activeInstallations,
    changeModel,
    hasSelectedModel,
    modelOptions,
    openInstalledApp,
    startInstalledApp,
    stopInstalledApp,
    installModelKey,
    ownedCards,
    visibleOwnedCards,
    visibleMarketplaceItems,
    hasItems,
    localState,
    selectDetails,
    closeDetails,
    currentInstallation,
    requireCurrentInstallation,
    withCurrentInstallation,
    download,
    install,
    openBuilder,
    addPluginToInstallation,
    createSmartApp,
    copySmartApp,
    linkSmartAppDirectory,
    importCreatedPackage,
    chooseCreatedPackage,
    dropCreatedPackage,
    availableUpdate,
    runtimeStateLabel,
    focusModelSelector,
    exportInstallation,
    verifyInstallation,
    localActions,
    deleteLocalInstallation,
  }
}
