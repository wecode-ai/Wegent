import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { CollaborationTemplateRemote } from './types'

/** A mounted search owns discovery, account metadata and its pagination requests. */
export function createTemplateCatalogResource(
  remote: CollaborationTemplateRemote | undefined,
  keyword: string
) {
  const discovery = createAsyncResource('discovery', () => remote!.discover({ keyword }), {
    refreshOnSubscribe: true,
  })
  const account = createAsyncResource('account', () => remote!.list(), { refreshOnSubscribe: true })
  const listeners = new Set<() => void>()
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stops: Array<() => void> = []
  let pageRevision = 0
  let pageLoading = false
  let pageError = false
  const read = () => {
    const found = discovery.getSnapshot()
    const owned = account.getSnapshot()
    return {
      listings: found.data?.items ?? [],
      mine: owned.data ?? [],
      nextCursor: found.data?.hasMore ? found.data.nextCursor : null,
      loading:
        Boolean(remote) &&
        (!started || found.status === 'loading' || owned.status === 'loading' || pageLoading),
      error: found.status === 'error' || owned.status === 'error' || pageError,
    }
  }
  let snapshot = read()
  const publish = () => {
    snapshot = read()
    listeners.forEach(listener => listener())
  }
  const start = () => {
    if (started || !remote || !listeners.size) return
    started = true
    stops = [discovery.subscribe(publish), account.subscribe(publish)]
    publish()
  }
  const activePage = (revision: number) => revision === pageRevision && listeners.size > 0
  return {
    getSnapshot: () => snapshot,
    hasSubscribers: () => listeners.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1 && remote) timer = setTimeout(start, 200)
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        clearTimeout(timer)
        stops.forEach(stop => stop())
        stops = []
        started = false
        pageRevision++
        pageLoading = false
        snapshot = read()
      }
    },
    async refresh() {
      if (!remote || !listeners.size) return
      clearTimeout(timer)
      pageRevision++
      pageLoading = false
      pageError = false
      if (!started) {
        start()
        return
      }
      await Promise.all([discovery.reload(), account.reload()])
    },
    async loadMore() {
      const cursor = snapshot.nextCursor
      if (!remote || !listeners.size || !cursor || snapshot.loading) return
      const revision = ++pageRevision
      pageLoading = true
      pageError = false
      publish()
      try {
        const result = await remote.discover({ keyword, cursor })
        if (!activePage(revision)) return
        discovery.update(previous => ({
          ...result,
          items: [...(previous?.items ?? []), ...result.items],
        }))
      } catch {
        if (activePage(revision)) pageError = true
      } finally {
        if (activePage(revision)) {
          pageLoading = false
          publish()
        }
      }
    },
    remove(id: number | null, identity: string) {
      pageRevision++
      pageLoading = false
      discovery.update(
        previous =>
          previous && { ...previous, items: previous.items.filter(item => item.id !== id) }
      )
      account.update(previous =>
        previous?.filter(item => `${item.ownerId}:${item.namespace}:${item.name}` !== identity)
      )
      publish()
    },
  }
}
