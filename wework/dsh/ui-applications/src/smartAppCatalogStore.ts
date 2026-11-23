import type { SetStateAction } from 'react'
import type { SmartAppMarketplaceItem, SmartAppMarketplaceTag, SmartAppsApi } from '@/api/smartApps'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import { getSmartAppErrorMessage, type SmartAppTranslate } from '@/lib/smart-app-error-message'

export interface CatalogOwner {
  api: SmartAppsApi | null
  mode: 'marketplace' | 'owned'
  query: string
  source: 'all' | 'official' | 'public' | 'shared'
  tag: string
}
interface CloudCatalog {
  items: SmartAppMarketplaceItem[]
  marketItems: SmartAppMarketplaceItem[]
  tags: SmartAppMarketplaceTag[]
}
interface CatalogResource<T> {
  data: T | null
  loading: boolean
  error: string | null
}
interface CatalogSnapshot {
  local: CatalogResource<HarnessAppInstallation[]>
  cloud: CatalogResource<CloudCatalog>
  operationError: string | null
}
export const EMPTY_CLOUD_CATALOG: CloudCatalog = { items: [], marketItems: [], tags: [] }
export const EMPTY_INSTALLATIONS: HarnessAppInstallation[] = []
const initialSnapshot = (): CatalogSnapshot => ({
  local: { data: null, loading: true, error: null },
  cloud: { data: null, loading: true, error: null },
  operationError: null,
})

async function loadCloud(owner: CatalogOwner): Promise<CloudCatalog> {
  const { api, mode, query, source, tag } = owner
  if (!api) return EMPTY_CLOUD_CATALOG
  const [catalog, marketplace, tagCatalog] = await Promise.all([
    mode === 'owned'
      ? api.listOwned()
      : api.listMarketplace({
          q: query,
          source: source === 'all' ? undefined : source,
          tag: tag || undefined,
        }),
    mode === 'owned' ? api.listMarketplace() : null,
    api.listTags().catch(() => ({ version: 0, items: [] })),
  ])
  return {
    items: catalog.items,
    marketItems: marketplace?.items ?? catalog.items,
    tags: tagCatalog.items.filter(item => item.enabled).sort((a, b) => a.sort - b.sort),
  }
}

/** Independent local/cloud requests share a catalog owner, never a request lifetime. */
export function createSmartAppCatalogStore() {
  let activeOwner: CatalogOwner | undefined
  let translate: SmartAppTranslate | undefined
  let snapshot = initialSnapshot()
  let localRequest = 0
  let cloudRequest = 0
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const isActive = (owner: CatalogOwner) => activeOwner === owner && listeners.size > 0
  const publish = (next: CatalogSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const errorMessage = (error: unknown, t: SmartAppTranslate) =>
    getSmartAppErrorMessage(error, t('workbench.smart_apps_load_failed', '智能工作台加载失败。'), t)
  const refreshLocal = async (owner: CatalogOwner, t: SmartAppTranslate) => {
    if (!isActive(owner)) return
    const request = ++localRequest
    publish({ ...snapshot, local: { ...snapshot.local, loading: true, error: null } })
    try {
      const data = await harnessAppsApi.list()
      if (isActive(owner) && request === localRequest)
        publish({ ...snapshot, local: { data, loading: false, error: null } })
    } catch (error) {
      if (isActive(owner) && request === localRequest)
        publish({
          ...snapshot,
          local: { ...snapshot.local, loading: false, error: errorMessage(error, t) },
        })
    }
  }
  const refreshCloud = async (owner: CatalogOwner, t: SmartAppTranslate) => {
    if (!isActive(owner)) return
    const request = ++cloudRequest
    publish({ ...snapshot, cloud: { ...snapshot.cloud, loading: true, error: null } })
    try {
      const data = await loadCloud(owner)
      if (isActive(owner) && request === cloudRequest)
        publish({ ...snapshot, cloud: { data, loading: false, error: null } })
    } catch (error) {
      if (isActive(owner) && request === cloudRequest)
        publish({
          ...snapshot,
          cloud: { ...snapshot.cloud, loading: false, error: errorMessage(error, t) },
        })
    }
  }
  const refresh = async () => {
    if (!activeOwner || !translate || !isActive(activeOwner)) return
    publish({ ...snapshot, operationError: null })
    const local = refreshLocal(activeOwner, translate)
    void refreshCloud(activeOwner, translate)
    await local
  }
  return {
    async refreshMode(mode: CatalogOwner['mode']) {
      if (activeOwner?.mode === mode) await refresh()
    },
    observe(owner: CatalogOwner) {
      const inactive = initialSnapshot()
      const readReadyData = () =>
        isActive(owner) && !snapshot.local.loading && !snapshot.local.error
          ? snapshot.local.data
          : null
      return {
        getSnapshot: () => (activeOwner === owner ? snapshot : inactive),
        subscribe(listener: () => void, t: SmartAppTranslate) {
          const changed = activeOwner !== owner
          listeners.add(listener)
          if (changed) {
            activeOwner = owner
            localRequest++
            cloudRequest++
            snapshot = inactive
          }
          translate = t
          clearTimeout(refreshTimer)
          refreshTimer = setTimeout(
            () => {
              if (isActive(owner)) void refresh()
            },
            owner.query ? 250 : 0
          )
          return () => {
            listeners.delete(listener)
            if (listeners.size) return
            clearTimeout(refreshTimer)
            localRequest++
            cloudRequest++
          }
        },
        readReadyData,
        setError(error: string | null) {
          if (isActive(owner)) publish({ ...snapshot, operationError: error })
        },
        invalidate() {
          if (!isActive(owner)) return
          localRequest++
          publish({ ...snapshot, local: { ...snapshot.local, loading: true } })
        },
        update(value: SetStateAction<HarnessAppInstallation[]>) {
          if (!isActive(owner) || !translate) return
          localRequest++
          const previous = snapshot.local.data
          if (previous === null) {
            void refreshLocal(owner, translate)
            return
          }
          const data = typeof value === 'function' ? value(previous) : value
          publish({ ...snapshot, local: { ...snapshot.local, data, loading: false } })
        },
      }
    },
  }
}
