import { useEffect, useMemo, useState } from 'react'
import type { ChatGroupApi } from '@/api/chatGroups'
import type { CloudProject } from '@/api/deliveries'
import { groupWorkContainer } from '@/api/groupWorkContainer'

/** Task targets include groups without inserting them into the real project catalog. */
export function useTaskGroupOwners(
  active: boolean,
  apis: { local?: ChatGroupApi; cloud?: ChatGroupApi } | undefined,
  accountScope: string
) {
  const scope = useMemo(
    () => ({ local: apis?.local, cloud: apis?.cloud, accountScope }),
    [apis?.local, apis?.cloud, accountScope]
  )
  const [snapshot, setSnapshot] = useState<{ owner: object; groups: CloudProject[] } | null>(null)
  useEffect(() => {
    if (!active) return
    let current = true
    const results = new Map<'local' | 'cloud', CloudProject[]>()
    for (const store of ['local', 'cloud'] as const) {
      const api = scope[store]
      if (!api) continue
      void api
        .list()
        .then(response => {
          if (!current) return
          results.set(
            store,
            response.items
              .filter(
                group =>
                  group.status === 'active' &&
                  ['Owner', 'Maintainer', 'Developer'].includes(group.role)
              )
              .map(group => groupWorkContainer(group, store))
          )
          setSnapshot({ owner: scope, groups: [...results.values()].flat() })
        })
        .catch(() => {
          if (!current) return
          results.set(store, [])
          setSnapshot({ owner: scope, groups: [...results.values()].flat() })
        })
    }
    return () => {
      current = false
    }
  }, [active, scope])
  return snapshot?.owner === scope ? snapshot.groups : []
}
