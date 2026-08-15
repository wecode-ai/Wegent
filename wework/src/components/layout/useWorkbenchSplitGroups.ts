import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  activateWorkbenchPane,
  closeActiveWorkbenchPane,
  createWorkbenchSplitGroupsState,
  focusActiveWorkbenchPane,
  getActiveWorkbenchLayout,
  getWorkbenchSplitGroupMemberships,
  migratePersistedWorkbenchSplitLayout,
  parsePersistedWorkbenchSplitGroups,
  placeActiveWorkbenchTask,
  pruneWorkbenchSplitGroups,
  serializeWorkbenchSplitGroups,
  splitActiveWorkbenchPane,
  updateActiveWorkbenchSplitSizes,
  type WorkbenchSplitGroupsState,
} from './workbenchSplitGroups'
import type { WorkbenchSplitDirection } from './workbenchSplitLayout'

interface UseWorkbenchSplitGroupsOptions {
  storageKey: string
  legacyStorageKey: string
  activePaneKey: string
  validRuntimeKeys: string[]
  runtimeKeysReady: boolean
}

export function workbenchSplitStorageKeys(scope: string) {
  return {
    storageKey: `wework:workbench-split-groups:v3:${scope}`,
    legacyStorageKey: `wework:workbench-split-layout:v2:${scope}`,
  }
}

export function useWorkbenchSplitGroups({
  storageKey,
  legacyStorageKey,
  activePaneKey,
  validRuntimeKeys,
  runtimeKeysReady,
}: UseWorkbenchSplitGroupsOptions) {
  const [state, setState] = useState<WorkbenchSplitGroupsState>(() => {
    if (typeof window === 'undefined') return createWorkbenchSplitGroupsState(activePaneKey)
    return (
      parsePersistedWorkbenchSplitGroups(window.localStorage.getItem(storageKey), activePaneKey) ??
      migratePersistedWorkbenchSplitLayout(
        window.localStorage.getItem(legacyStorageKey),
        activePaneKey
      ) ??
      createWorkbenchSplitGroupsState(activePaneKey)
    )
  })
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  const commit = useCallback(
    (update: (current: WorkbenchSplitGroupsState) => WorkbenchSplitGroupsState) => {
      const next = update(stateRef.current)
      stateRef.current = next
      setState(next)
      return next
    },
    []
  )

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, serializeWorkbenchSplitGroups(state))
    } catch (error) {
      console.warn('Failed to persist workbench split groups:', error)
    }
  }, [state, storageKey])

  useEffect(() => {
    commit(current => activateWorkbenchPane(current, activePaneKey))
  }, [activePaneKey, commit])

  useEffect(() => {
    if (!runtimeKeysReady) return
    const validKeys = new Set([...validRuntimeKeys, activePaneKey])
    commit(current => pruneWorkbenchSplitGroups(current, validKeys, activePaneKey))
  }, [activePaneKey, commit, runtimeKeysReady, validRuntimeKeys])

  const activeLayout = getActiveWorkbenchLayout(state)
  const memberships = useMemo(() => getWorkbenchSplitGroupMemberships(state), [state])
  const splitMode = state.activeView.type === 'group'

  const activatePane = useCallback(
    (paneKey: string) => commit(current => activateWorkbenchPane(current, paneKey)),
    [commit]
  )
  const focusPane = useCallback(
    (paneId: string) => commit(current => focusActiveWorkbenchPane(current, paneId)),
    [commit]
  )
  const closePane = useCallback(
    (paneId: string) => commit(current => closeActiveWorkbenchPane(current, paneId, activePaneKey)),
    [activePaneKey, commit]
  )
  const splitPane = useCallback(
    (paneId: string, direction: WorkbenchSplitDirection) =>
      commit(current => splitActiveWorkbenchPane(current, paneId, direction)),
    [commit]
  )
  const placeTask = useCallback(
    (paneKey: string, targetPaneId: string, position: 'center' | WorkbenchSplitDirection) =>
      commit(current =>
        placeActiveWorkbenchTask(current, paneKey, targetPaneId, position, activePaneKey)
      ),
    [activePaneKey, commit]
  )
  const updateSizes = useCallback(
    (splitId: string, sizes: Record<string, number>) =>
      commit(current => updateActiveWorkbenchSplitSizes(current, splitId, sizes)),
    [commit]
  )

  return useMemo(
    () => ({
      state,
      activeLayout,
      memberships,
      splitMode,
      activatePane,
      focusPane,
      closePane,
      splitPane,
      placeTask,
      updateSizes,
    }),
    [
      activatePane,
      activeLayout,
      closePane,
      focusPane,
      memberships,
      placeTask,
      splitMode,
      splitPane,
      state,
      updateSizes,
    ]
  )
}

export type WorkbenchSplitGroupsController = ReturnType<typeof useWorkbenchSplitGroups>
