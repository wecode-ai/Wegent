/* eslint-disable react-hooks/refs -- Pane identities are cached intentionally so live UI resources survive conversation switches. */
/* eslint-disable react-refresh/only-export-components -- The active-pane hook belongs to this stack context. */
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { getWorkbenchPaneKey, type WorkbenchPaneIdentity } from './workbenchPaneIdentity'

interface CachedWorkbenchPaneStackProps {
  activePane: WorkbenchPaneIdentity
  maxPanes: number
  pinnedKeys: string[]
  prunedKeys: string[]
  validRuntimeKeys: string[]
  activeTestId: string
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}

export function CachedWorkbenchPaneStack({
  activePane,
  maxPanes,
  pinnedKeys,
  prunedKeys,
  validRuntimeKeys,
  activeTestId,
  renderPane,
}: CachedWorkbenchPaneStackProps) {
  const activeKey = getWorkbenchPaneKey(activePane)
  const paneCacheRef = useRef(new Map<string, WorkbenchPaneIdentity>())
  const [cachedKeys, setCachedKeys] = useState(() => [activeKey])
  const cachedKeysRef = useRef(cachedKeys)
  const recentKeysRef = useRef([activeKey])
  const pinnedKeySet = useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const validRuntimeKeySet = useMemo(() => new Set(validRuntimeKeys), [validRuntimeKeys])
  const prunedKeySet = useMemo(
    () =>
      new Set([
        ...prunedKeys.filter(key => key !== activeKey),
        ...cachedKeysRef.current.filter(
          key => key !== activeKey && key.startsWith('runtime:') && !validRuntimeKeySet.has(key)
        ),
      ]),
    [activeKey, prunedKeys, validRuntimeKeySet]
  )
  cachedKeysRef.current = cachedKeys
  paneCacheRef.current.set(activeKey, activePane)
  recentKeysRef.current = markRecentlyUsed(recentKeysRef.current, activeKey)

  useEffect(() => {
    setCachedKeys(previousKeys => {
      const retainedKeys = previousKeys.filter(key => !prunedKeySet.has(key))
      const nextKeys = getStableCachedPaneKeys(
        retainedKeys,
        activeKey,
        maxPanes,
        recentKeysRef.current.filter(key => !prunedKeySet.has(key)),
        pinnedKeySet
      )
      if (sameKeys(previousKeys, nextKeys)) return previousKeys
      paneCacheRef.current.forEach((_, key) => {
        if (!nextKeys.includes(key)) paneCacheRef.current.delete(key)
      })
      recentKeysRef.current = recentKeysRef.current.filter(key => nextKeys.includes(key))
      return nextKeys
    })
  }, [activeKey, maxPanes, pinnedKeySet, prunedKeySet])

  const renderKeys = getStableCachedPaneKeys(
    cachedKeys.filter(key => !prunedKeySet.has(key)),
    activeKey,
    maxPanes,
    recentKeysRef.current.filter(key => !prunedKeySet.has(key)),
    pinnedKeySet
  )

  return (
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
      {renderKeys.map(key => {
        const pane = paneCacheRef.current.get(key)
        if (!pane) return null
        const active = key === activeKey
        return (
          <WorkbenchPaneActiveContext.Provider key={key} value={active}>
            <div
              data-active-workbench-pane={active ? 'true' : 'false'}
              data-testid={active ? activeTestId : undefined}
              aria-hidden={!active}
              hidden={!active}
              className={cn(
                'absolute inset-0 min-w-0 overflow-hidden',
                active ? 'z-10' : 'pointer-events-none z-0'
              )}
            >
              <CachedWorkbenchPane pane={pane} renderPane={renderPane} />
            </div>
          </WorkbenchPaneActiveContext.Provider>
        )
      })}
    </div>
  )
}

const WorkbenchPaneActiveContext = createContext(true)

export function useWorkbenchPaneActive() {
  return useContext(WorkbenchPaneActiveContext)
}

const CachedWorkbenchPane = memo(function CachedWorkbenchPane({
  pane,
  renderPane,
}: {
  pane: WorkbenchPaneIdentity
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}) {
  return <>{renderPane(pane)}</>
})

function getStableCachedPaneKeys(
  keys: string[],
  activeKey: string,
  maxPanes: number,
  recentKeys: string[],
  pinnedKeys: ReadonlySet<string>
) {
  let nextKeys = keys.includes(activeKey) ? keys : [...keys, activeKey]
  const maxCount = Math.max(1, maxPanes) + nextKeys.filter(key => pinnedKeys.has(key)).length
  while (nextKeys.length > maxCount) {
    const evictKey =
      recentKeys.find(key => key !== activeKey && !pinnedKeys.has(key) && nextKeys.includes(key)) ??
      nextKeys.find(key => key !== activeKey && !pinnedKeys.has(key))
    if (!evictKey) break
    nextKeys = nextKeys.filter(key => key !== evictKey)
  }
  return nextKeys
}

function markRecentlyUsed(keys: string[], activeKey: string) {
  return [...keys.filter(key => key !== activeKey), activeKey]
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index])
}
