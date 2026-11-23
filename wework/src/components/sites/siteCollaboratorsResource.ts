import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { SiteCollaborator, SitesApi } from '@/api/sites'

/** Accepted mutations overlay only list reads that started before those mutations. */
export function createSiteCollaboratorsResource(api: SitesApi, siteId: string) {
  const listeners = new Set<() => void>()
  let revision = 0
  const changes = new Map<string, { revision: number; item: SiteCollaborator | null }>()
  let state = {
    items: [] as SiteCollaborator[],
    loading: true,
    failure: null as { cause: unknown } | null,
  }
  let stop: (() => void) | undefined
  const query = createAsyncResource('site/collaborators', async () => {
    const started = revision
    const { items } = await api.listCollaborators(siteId)
    return { items, revision: started }
  })
  const publish = () => {
    const source = query.getSnapshot()
    const items = new Map((source.data?.items ?? []).map(item => [item.subject, item]))
    for (const [subject, change] of changes) {
      if (change.revision <= (source.data?.revision ?? -1)) continue
      if (change.item) items.set(subject, change.item)
      else items.delete(subject)
    }
    state = {
      items: [...items.values()],
      loading: source.status === 'idle' || source.status === 'loading',
      failure: source.status === 'error' ? { cause: source.error } : null,
    }
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) stop = query.subscribe(publish)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stop?.()
          stop = undefined
        }
      }
    },
    reload: () => query.reload(),
    accept(subject: string, item: SiteCollaborator | null) {
      if (!listeners.size) return
      changes.set(subject, { revision: ++revision, item })
      publish()
    },
  }
}
