import { beginOperation } from '@/telemetry/operationBus'
import type { PluginPublicationRequestItem } from '@/types/api'
import type { createPluginCatalogState, PluginCatalogInput } from './pluginCatalogState'

export const TERMINAL_PUBLICATION_STATUSES = new Set(['published', 'withdrawn', 'closed'])
export function comparePublicationRequests(
  left: PluginPublicationRequestItem,
  right: PluginPublicationRequestItem
): number {
  const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  return difference !== 0 ? difference : right.id - left.id
}
export function mergePublicationRequests(
  current: PluginPublicationRequestItem[],
  incoming: PluginPublicationRequestItem[]
) {
  const byId = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort(comparePublicationRequests)
}
export function matchingPublicationRequests(
  publications: PluginPublicationRequestItem[],
  sourcePluginId: number | null,
  pluginSlug: string
) {
  const normalized = pluginSlug.trim().toLowerCase()
  return publications
    .filter(
      item =>
        (sourcePluginId !== null && item.pluginId === sourcePluginId) ||
        item.pluginSlug.trim().toLowerCase() === normalized
    )
    .sort(comparePublicationRequests)
}
export function selectPrimaryPublication(publications: PluginPublicationRequestItem[]) {
  return (
    publications.find(item => !TERMINAL_PUBLICATION_STATUSES.has(item.status)) ??
    publications.find(item => item.status === 'published') ??
    publications[0] ??
    null
  )
}
export function createPluginPublicationState(
  api: PluginCatalogInput['pluginApi'],
  catalog: ReturnType<typeof createPluginCatalogState>
) {
  let snapshot: {
    publicationRequests: PluginPublicationRequestItem[]
    publicationProgress: PluginPublicationRequestItem | null
    publicationProgressLoading: boolean
    withdrawingPublicationId: number | null
  } = {
    publicationRequests: [],
    publicationProgress: null,
    publicationProgressLoading: false,
    withdrawingPublicationId: null,
  }
  let translate: PluginCatalogInput['t'] | undefined
  let generation = 0
  let progressRequest = 0
  let mutationRevision = 0
  const writtenAt = new Map<number, number>()
  const observers = new Set<() => void>()
  let initialized = false
  const current = (version: number) => generation === version && observers.size > 0
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    observers.forEach(listener => listener())
  }
  const remember = (items: PluginPublicationRequestItem[]) =>
    publish({ publicationRequests: mergePublicationRequests(snapshot.publicationRequests, items) })
  const recordWrite = (items: PluginPublicationRequestItem[]) => {
    const revision = ++mutationRevision
    for (const item of items) writtenAt.set(item.id, revision)
    remember(items)
  }
  const refresh = async (sourcePluginId?: number) => {
    const readRevision = mutationRevision
    const version = generation
    const scopeIsCurrent = catalog.captureScope()
    const first = await api.listPublicationRequests({ sourcePluginId, page: 1, limit: 100 })
    if (!current(version) || !scopeIsCurrent()) return []
    const pageCount = Math.max(1, Math.ceil(first.total / 100))
    const remaining = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, index) =>
        api.listPublicationRequests({ sourcePluginId, page: index + 2, limit: 100 })
      )
    )
    if (!current(version) || !scopeIsCurrent()) return []
    const details = await Promise.all(
      [first, ...remaining]
        .flatMap(page => page.items)
        .map(item => api.getPublicationRequest(item.id))
    )
    if (!current(version) || !scopeIsCurrent()) return []
    remember(details.filter(item => (writtenAt.get(item.id) ?? 0) <= readRevision))
    return details.sort(comparePublicationRequests)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(t: PluginCatalogInput['t'], listener: () => void) {
      translate = t
      observers.add(listener)
      if (!initialized) {
        initialized = true
        void refresh().catch(() => undefined)
      }
      return () => {
        observers.delete(listener)
        queueMicrotask(() => {
          if (!observers.size) {
            generation += 1
            progressRequest += 1
            initialized = false
            publish({ publicationProgressLoading: false, withdrawingPublicationId: null })
          }
        })
      }
    },
    refresh,
    remember(items: PluginPublicationRequestItem[]) {
      if (observers.size) recordWrite(items)
    },
    closeProgress() {
      progressRequest += 1
      publish({ publicationProgress: null, publicationProgressLoading: false })
    },
    async openProgress(requestId: number, revisionNumber?: number) {
      const version = generation
      const request = ++progressRequest
      const scopeIsCurrent = catalog.captureScope()
      const cached = snapshot.publicationRequests.find(item => item.id === requestId)
      publish({
        publicationProgressLoading: true,
        ...(cached && revisionNumber === undefined ? { publicationProgress: cached } : {}),
      })
      try {
        const publication = await api.getPublicationRequest(requestId, revisionNumber)
        if (!current(version) || !scopeIsCurrent() || request !== progressRequest) return
        publish({ publicationProgress: publication })
        if (
          revisionNumber === undefined ||
          publication.revision.number === publication.currentRevision
        )
          remember([publication])
      } catch (error) {
        if (current(version) && scopeIsCurrent() && request === progressRequest)
          catalog.reportError(
            error instanceof Error ? error.message : 'Failed to load publication request'
          )
      } finally {
        if (current(version) && request === progressRequest)
          publish({ publicationProgressLoading: false })
      }
    },
    async withdraw(publication: PluginPublicationRequestItem) {
      const version = generation
      const scopeIsCurrent = catalog.captureScope()
      publish({ withdrawingPublicationId: publication.id })
      const attempt = beginOperation('plugin.withdraw')
      try {
        const updated = await api.withdrawPublicationRequest(
          publication.id,
          publication.currentRevision
        )
        if (!current(version) || !scopeIsCurrent()) {
          attempt.cancel()
          return
        }
        attempt.succeed()
        recordWrite([updated])
        if (snapshot.publicationProgress?.id === updated.id) {
          progressRequest += 1
          publish({ publicationProgress: updated, publicationProgressLoading: false })
        }
        catalog.showNotice({
          id: 'publication-withdrawn-' + updated.id,
          kind: 'success',
          message:
            translate?.('workbench.plugins_publication_withdrawn_notice', '全员发布申请已撤回。') ??
            '全员发布申请已撤回。',
        })
      } catch (error) {
        if (!current(version) || !scopeIsCurrent()) {
          attempt.cancel()
          return
        }
        attempt.fail('request')
        catalog.reportError(
          error instanceof Error ? error.message : 'Failed to withdraw publication request'
        )
      } finally {
        if (current(version)) publish({ withdrawingPublicationId: null })
      }
    },
  }
}
