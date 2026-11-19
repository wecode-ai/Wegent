import type { CloudMyWorkItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

export interface PendingProjectIssue {
  item: CloudMyWorkItem
  store: 'local' | 'backend'
  userId: number | readonly number[]
}
type Store = PendingProjectIssue['store']
interface WorkReader {
  listMyWork(options: { cursor?: string }): Promise<{
    items: CloudMyWorkItem[]
    errors?: string[]
    next_cursor?: string | null
  }>
}
type LiveClient = WorkbenchServices['projectChatClient']
interface PendingSnapshot {
  items: PendingProjectIssue[]
  errors: Record<string, string>
  loading: Record<Store, boolean>
}

/** Each source publishes independently; detaching revokes reads and live callbacks. */
export function createPendingProjectIssuesStore({
  local,
  cloud,
  userId,
  localViewer,
  localClient,
  cloudClient,
}: {
  local?: WorkReader
  cloud?: WorkReader
  userId?: number
  localViewer: number | readonly number[]
  localClient?: LiveClient
  cloudClient?: LiveClient
}) {
  const listeners = new Set<() => void>()
  const sequences = new Map<Store, number>()
  let epoch = 0
  let disconnect: (() => void) | undefined
  let snapshot: PendingSnapshot = {
    items: [],
    errors: {},
    loading: { local: Boolean(local), backend: Boolean(cloud && userId != null) },
  }
  const publish = (next: PendingSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const refresh = async (onlyStore?: Store) => {
    if (!listeners.size) return
    const generation = epoch
    await Promise.resolve()
    if (generation !== epoch || !listeners.size) return
    await Promise.all(
      (
        [
          ['local', local, localViewer],
          ['backend', cloud, userId],
        ] as const
      ).map(async ([store, api, viewer]) => {
        if (!api || viewer == null || (onlyStore && onlyStore !== store)) return
        const sequence = (sequences.get(store) ?? 0) + 1
        sequences.set(store, sequence)
        const current = () =>
          generation === epoch && listeners.size > 0 && sequences.get(store) === sequence
        publish({ ...snapshot, loading: { ...snapshot.loading, [store]: true } })
        try {
          const collected = new Map<string, CloudMyWorkItem>()
          const seen = new Set<string>()
          const errors: string[] = []
          let cursor: string | undefined
          do {
            const response = await api.listMyWork({ cursor })
            if (!current()) return
            for (const item of response.items)
              collected.set(`${item.cloud_project_id}:${item.id}`, item)
            errors.push(...(response.errors ?? []))
            publish({
              ...snapshot,
              items: [
                ...snapshot.items.filter(row => row.store !== store),
                ...[...collected.values()].map(item => ({ item, store, userId: viewer })),
              ],
              errors: { ...snapshot.errors, [store]: errors.join('\n') },
            })
            cursor = response.next_cursor || undefined
            if (cursor && seen.has(cursor)) throw new Error('Repeated project-work cursor')
            if (cursor) seen.add(cursor)
          } while (cursor)
        } catch (error) {
          if (current())
            publish({
              ...snapshot,
              errors: {
                ...snapshot.errors,
                [store]: error instanceof Error ? error.message : String(error),
              },
            })
        } finally {
          if (current()) publish({ ...snapshot, loading: { ...snapshot.loading, [store]: false } })
        }
      })
    )
  }
  const connect = () => {
    const generation = ++epoch
    void refresh()
    const timer = local ? setInterval(() => void refresh('local'), 30_000) : undefined
    const releases: (() => void)[] = []
    const pending = new Map<Store, ReturnType<typeof setTimeout>>()
    for (const [store, client] of [
      ['local', localClient],
      ['backend', cloudClient],
    ] as const) {
      if (!client?.subscribeLoopItemChanges) continue
      void client
        .subscribeLoopItemChanges(() => {
          if (generation !== epoch || !listeners.size) return
          clearTimeout(pending.get(store))
          pending.set(
            store,
            setTimeout(() => {
              pending.delete(store)
              void refresh(store)
            }, 200)
          )
        })
        .then(release => {
          if (generation !== epoch || !listeners.size) release()
          else releases.push(release)
        })
        .catch(error => {
          if (generation === epoch && listeners.size)
            publish({
              ...snapshot,
              errors: { ...snapshot.errors, [`live:${store}`]: String(error) },
            })
        })
    }
    return () => {
      epoch++
      clearInterval(timer)
      for (const release of releases) release()
      for (const timeout of pending.values()) clearTimeout(timeout)
    }
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1 && (local || cloud)) disconnect = connect()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          disconnect?.()
          disconnect = undefined
        }
      }
    },
  }
}
