import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { issueNeedsUser } from '@wegent/collaboration'
import type { CloudMyWorkItem } from '@/api/deliveries'
import { useNotificationTaskSource } from './NotificationTaskSourceContext'

export interface PendingProjectIssue {
  item: CloudMyWorkItem
  store: 'local' | 'backend'
  userId: number
}

/** This page owns its reads; project failures do not erase another store's results. */
export function usePendingProjectIssues(active: boolean) {
  const source = useNotificationTaskSource()
  const local = source?.services?.projectSpaceApis?.local
  const cloud =
    source?.services?.projectSpaceApis?.cloud ??
    (source?.services?.issueHumanRequestsApi ? source.services.deliveryApi : undefined)
  const userId = source?.userId
  const scope = useMemo(() => ({ local, cloud, userId }), [local, cloud, userId])
  const epoch = useRef(0)
  const sequences = useRef(new Map<string, number>())
  const [loading, setLoading] = useState<{ scope: typeof scope; local: boolean; backend: boolean }>(
    { scope, local: Boolean(local && active), backend: Boolean(cloud && userId != null && active) }
  )
  const [snapshot, setSnapshot] = useState<{
    scope: typeof scope
    items: PendingProjectIssue[]
    errors: Record<string, string>
  }>({ scope, items: [], errors: {} })
  const refresh = useCallback(
    async (onlyStore?: 'local' | 'backend') => {
      const generation = epoch.current
      await Promise.resolve()
      const reads = [
        ['local', local, 0],
        ['backend', cloud, userId],
      ] as const
      await Promise.all(
        reads.map(async ([store, api, viewer]) => {
          if (!api || viewer == null || (onlyStore && onlyStore !== store)) return
          const sequence = (sequences.current.get(store) ?? 0) + 1
          sequences.current.set(store, sequence)
          const current = () =>
            generation === epoch.current && sequences.current.get(store) === sequence
          setLoading(previous => ({
            scope,
            local: previous.scope === scope ? previous.local : false,
            backend: previous.scope === scope ? previous.backend : false,
            [store]: true,
          }))
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
              setSnapshot(previous => ({
                scope,
                items: [
                  ...(previous.scope === scope
                    ? previous.items.filter(row => row.store !== store)
                    : []),
                  ...[...collected.values()].map(item => ({ item, store, userId: viewer })),
                ],
                errors: {
                  ...(previous.scope === scope ? previous.errors : {}),
                  [store]: errors.join('\n'),
                },
              }))
              cursor = response.next_cursor || undefined
              if (cursor && seen.has(cursor)) throw new Error('Repeated project-work cursor')
              if (cursor) seen.add(cursor)
            } while (cursor)
          } catch (error) {
            if (!current()) return
            setSnapshot(current => ({
              scope,
              items: current.scope === scope ? current.items : [],
              errors: {
                ...(current.scope === scope ? current.errors : {}),
                [store]: error instanceof Error ? error.message : String(error),
              },
            }))
          } finally {
            if (current())
              setLoading(previous =>
                previous.scope === scope ? { ...previous, [store]: false } : previous
              )
          }
        })
      )
    },
    [scope, local, cloud, userId]
  )
  useEffect(() => {
    if (!active || (!local && !cloud)) return
    const generation = ++epoch.current
    void refresh()
    const timer = local ? window.setInterval(() => void refresh('local'), 30_000) : undefined
    const focused = () => void refresh()
    window.addEventListener('focus', focused)
    let disposed = false
    const releases: (() => void)[] = []
    const pending = new Map<string, number>()
    for (const [store, client] of [
      ['local', source?.services?.localProjectChatClient],
      ['backend', source?.services?.projectChatClient],
    ] as const) {
      if (!client?.subscribeLoopItemChanges) continue
      void client
        .subscribeLoopItemChanges(() => {
          window.clearTimeout(pending.get(store))
          pending.set(
            store,
            window.setTimeout(() => {
              pending.delete(store)
              void refresh(store)
            }, 200)
          )
        })
        .then(release => (disposed ? release() : releases.push(release)))
        .catch(error => {
          if (!disposed)
            setSnapshot(previous => ({
              scope,
              items: previous.scope === scope ? previous.items : [],
              errors: {
                ...(previous.scope === scope ? previous.errors : {}),
                [`live:${store}`]: String(error),
              },
            }))
        })
    }
    return () => {
      disposed = true
      epoch.current = generation + 1
      window.clearInterval(timer)
      window.removeEventListener('focus', focused)
      for (const release of releases) release()
      for (const timeout of pending.values()) window.clearTimeout(timeout)
    }
  }, [
    active,
    local,
    cloud,
    refresh,
    scope,
    source?.services?.localProjectChatClient,
    source?.services?.projectChatClient,
  ])
  return {
    items:
      snapshot.scope === scope
        ? snapshot.items.filter(row => {
            const running = source?.items.some(task => {
              const origin = task.task.runtimeHandle?.origin as Record<string, unknown> | undefined
              return (
                task.task.running &&
                origin &&
                String(origin.cloudProjectId) === String(row.item.cloud_project_id) &&
                origin.loopItemId === row.item.id &&
                (origin.projectStore ?? 'backend') === row.store
              )
            })
            return issueNeedsUser(
              running ? { ...row.item, execution_state: 'running' } : row.item,
              row.userId
            )
          })
        : [],
    errors: snapshot.scope === scope ? snapshot.errors : {},
    loading:
      active &&
      (snapshot.scope !== scope || (loading.scope === scope && (loading.local || loading.backend))),
    refresh,
  }
}
