/* eslint-disable react-hooks/refs -- Inactive workbench panes are intentionally cached in refs so their local UI state survives pane switches. */
/* eslint-disable react-refresh/only-export-components -- The stack exports pane identity helpers used by layout modules. */
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { cn } from '@/lib/utils'

export interface WorkbenchPaneIdentity {
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProject: ProjectWithTasks | null
  standaloneChatKey?: number
}

export function getWorkbenchPaneKey({
  currentRuntimeTask,
  standaloneChatKey,
}: WorkbenchPaneIdentity): string {
  if (currentRuntimeTask) {
    return ['runtime', currentRuntimeTask.deviceId, currentRuntimeTask.taskId].join(':')
  }
  const blankPaneKey = standaloneChatKey ?? 0
  return `blank:${blankPaneKey}`
}

export function getRunningRuntimeWorkbenchPaneKeys(
  runtimeWork: RuntimeWorkListResponse | null | undefined
): string[] {
  if (!runtimeWork) return []
  const keys: string[] = []
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]
  workspaces.forEach(workspace => {
    workspace.tasks.forEach(task => {
      if (task.running !== true) return
      keys.push(
        getWorkbenchPaneKey({
          currentRuntimeTask: {
            deviceId: workspace.deviceId,
            taskId: task.taskId,
          },
          currentProject: null,
        })
      )
    })
  })
  return keys
}

interface CachedWorkbenchPaneStackProps {
  activePane: WorkbenchPaneIdentity
  maxPanes: number
  pinnedKeys?: string[]
  prunedKeys?: string[]
  className?: string
  activeTestId?: string
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}

export function CachedWorkbenchPaneStack({
  activePane,
  maxPanes,
  pinnedKeys = [],
  prunedKeys = [],
  className,
  activeTestId,
  renderPane,
}: CachedWorkbenchPaneStackProps) {
  const activeKey = getWorkbenchPaneKey(activePane)
  const pinnedKeySet = useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const prunedKeySet = useMemo(
    () => new Set(prunedKeys.filter(key => key !== activeKey)),
    [activeKey, prunedKeys]
  )
  const paneCacheRef = useRef<Map<string, WorkbenchPaneIdentity>>(new Map())
  const [cachedKeys, setCachedKeys] = useState<string[]>(() => [activeKey])
  const cachedKeysRef = useRef<string[]>(cachedKeys)
  const recentKeysRef = useRef<string[]>([activeKey])
  cachedKeysRef.current = cachedKeys

  paneCacheRef.current.set(activeKey, activePane)
  recentKeysRef.current = markRecentlyUsed(recentKeysRef.current, activeKey)

  useEffect(() => {
    const currentKeys = cachedKeysRef.current
    const hasPrunedKeys = currentKeys.some(key => prunedKeySet.has(key))
    if (
      !hasPrunedKeys &&
      currentKeys.includes(activeKey) &&
      currentKeys.length <= Math.max(1, maxPanes) + pinnedKeySet.size
    ) {
      return
    }

    setCachedKeys(previousKeys => {
      const retainedKeys = previousKeys.filter(key => !prunedKeySet.has(key))
      const nextKeys = getStableCachedPaneKeys(
        retainedKeys,
        activeKey,
        maxPanes,
        recentKeysRef.current.filter(key => !prunedKeySet.has(key)),
        pinnedKeySet
      )
      if (areStringArraysEqual(previousKeys, nextKeys)) return previousKeys

      prunePaneCache(paneCacheRef.current, nextKeys)
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
                active ? 'visible z-10' : 'invisible pointer-events-none z-0'
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
  recentKeys: string[],
  pinnedKeys: ReadonlySet<string> = new Set()
): string[] {
  const maxCount = Math.max(1, maxPanes)
  const nextKeys = keys.includes(activeKey) ? keys : [...keys, activeKey]
  const pinnedExistingKeys = nextKeys.filter(key => pinnedKeys.has(key))
  const effectiveMaxCount = maxCount + pinnedExistingKeys.length
  if (nextKeys.length <= effectiveMaxCount) return nextKeys

  const evictableKeys = recentKeys.filter(
    key => key !== activeKey && !pinnedKeys.has(key) && nextKeys.includes(key)
  )
  const evictKey =
    evictableKeys[0] ?? nextKeys.find(key => key !== activeKey && !pinnedKeys.has(key))
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
