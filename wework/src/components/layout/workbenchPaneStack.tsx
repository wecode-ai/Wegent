import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { cn } from '@/lib/utils'

export interface WorkbenchPaneIdentity {
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProject: ProjectWithTasks | null
}

export function getWorkbenchPaneKey({
  currentRuntimeTask,
  currentProject,
}: WorkbenchPaneIdentity): string {
  if (currentRuntimeTask) {
    return [
      'runtime',
      currentRuntimeTask.deviceId,
      currentRuntimeTask.localTaskId,
      currentRuntimeTask.workspacePath ?? '',
    ].join(':')
  }
  return currentProject ? `project:${currentProject.id}` : 'standalone'
}

interface CachedWorkbenchPaneStackProps {
  activePane: WorkbenchPaneIdentity
  maxPanes: number
  className?: string
  activeTestId?: string
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}

export function CachedWorkbenchPaneStack({
  activePane,
  maxPanes,
  className,
  activeTestId,
  renderPane,
}: CachedWorkbenchPaneStackProps) {
  const activeKey = getWorkbenchPaneKey(activePane)
  const paneCacheRef = useRef<Map<string, WorkbenchPaneIdentity>>(new Map())
  const [cachedKeys, setCachedKeys] = useState<string[]>(() => [activeKey])
  const cachedKeysRef = useRef<string[]>(cachedKeys)
  const recentKeysRef = useRef<string[]>([activeKey])
  const activePaneWasCached = paneCacheRef.current.has(activeKey)
  cachedKeysRef.current = cachedKeys

  if (!activePaneWasCached) {
    paneCacheRef.current.set(activeKey, activePane)
  }
  recentKeysRef.current = markRecentlyUsed(recentKeysRef.current, activeKey)

  useEffect(() => {
    const currentKeys = cachedKeysRef.current
    if (currentKeys.includes(activeKey) && currentKeys.length <= Math.max(1, maxPanes)) {
      return
    }

    setCachedKeys(previousKeys => {
      const nextKeys = getStableCachedPaneKeys(
        previousKeys,
        activeKey,
        maxPanes,
        recentKeysRef.current
      )
      if (areStringArraysEqual(previousKeys, nextKeys)) return previousKeys

      prunePaneCache(paneCacheRef.current, nextKeys)
      recentKeysRef.current = recentKeysRef.current.filter(key => nextKeys.includes(key))
      return nextKeys
    })
  }, [activeKey, maxPanes])

  const renderKeys = getStableCachedPaneKeys(cachedKeys, activeKey, maxPanes, recentKeysRef.current)

  return (
    <div className={cn('relative flex min-w-0 flex-1 overflow-hidden', className)}>
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

export function useWorkbenchPaneActive(): boolean {
  return useContext(WorkbenchPaneActiveContext)
}

export function WorkbenchPaneActiveOnly({ children }: { children: ReactNode }) {
  return useWorkbenchPaneActive() ? <>{children}</> : null
}

interface CachedWorkbenchPaneProps {
  pane: WorkbenchPaneIdentity
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}

const CachedWorkbenchPane = memo(function CachedWorkbenchPane({
  pane,
  renderPane,
}: CachedWorkbenchPaneProps) {
  return <>{renderPane(pane)}</>
})

function getStableCachedPaneKeys(
  keys: string[],
  activeKey: string,
  maxPanes: number,
  recentKeys: string[]
): string[] {
  const maxCount = Math.max(1, maxPanes)
  const nextKeys = keys.includes(activeKey) ? keys : [...keys, activeKey]
  if (nextKeys.length <= maxCount) return nextKeys

  const evictableKeys = recentKeys.filter(key => key !== activeKey && nextKeys.includes(key))
  const evictKey = evictableKeys[0] ?? nextKeys.find(key => key !== activeKey)
  return evictKey ? nextKeys.filter(key => key !== evictKey) : nextKeys.slice(-maxCount)
}

function markRecentlyUsed(keys: string[], activeKey: string): string[] {
  return [...keys.filter(key => key !== activeKey), activeKey]
}

function prunePaneCache(cache: Map<string, WorkbenchPaneIdentity>, keys: string[]) {
  cache.forEach((_, key) => {
    if (!keys.includes(key)) {
      cache.delete(key)
    }
  })
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
