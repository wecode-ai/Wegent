import { useCallback, useState } from 'react'

interface CollapsedReadConversations {
  scope: string
  keys: ReadonlySet<string>
}

export function useCollapsedReadConversations(
  scope: string,
  taskKeys: ReadonlySet<string>,
  keepVisibleTaskKeys: ReadonlySet<string>
) {
  const [snapshot, setSnapshot] = useState<CollapsedReadConversations>(() => ({
    scope,
    keys: new Set(),
  }))
  let current = snapshot
  if (snapshot.scope !== scope) {
    current = { scope, keys: new Set() }
  } else if ([...snapshot.keys].some(key => keepVisibleTaskKeys.has(key) || !taskKeys.has(key))) {
    // Once a conversation returns, becoming read or idle must not hide it again until
    // the next explicit collapse action.
    current = {
      scope,
      keys: new Set(
        [...snapshot.keys].filter(key => taskKeys.has(key) && !keepVisibleTaskKeys.has(key))
      ),
    }
  }
  if (current !== snapshot) setSnapshot(current)

  const collapseReadConversations = useCallback(() => {
    setSnapshot({
      scope,
      keys: new Set([...taskKeys].filter(key => !keepVisibleTaskKeys.has(key))),
    })
  }, [scope, taskKeys, keepVisibleTaskKeys])
  const expandReadConversations = useCallback(
    (keys?: ReadonlySet<string>) => {
      setSnapshot(previous => ({
        scope,
        keys:
          keys && previous.scope === scope
            ? new Set([...previous.keys].filter(key => !keys.has(key)))
            : new Set(),
      }))
    },
    [scope]
  )

  return {
    collapsedReadTaskKeys: current.keys,
    collapseReadConversations,
    expandReadConversations,
  }
}
