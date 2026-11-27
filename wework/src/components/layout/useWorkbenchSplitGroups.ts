import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createWorkbenchSplitGroupsOwner, type SplitGroupsInput } from './workbenchSplitGroupsOwner'
import {
  activateWorkbenchPane,
  closeActiveWorkbenchPane,
  focusActiveWorkbenchPane,
  getActiveWorkbenchLayout,
  placeActiveWorkbenchTask,
  splitActiveWorkbenchPane,
  updateActiveWorkbenchSplitSizes,
} from './workbenchSplitGroups'
import type { WorkbenchSplitDirection } from './workbenchSplitLayout'

type UseWorkbenchSplitGroupsOptions = SplitGroupsInput

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
  const [owner] = useState(createWorkbenchSplitGroupsOwner)
  const runtimeKeys = JSON.stringify(validRuntimeKeys)
  const input = useMemo<SplitGroupsInput>(
    () => ({
      storageKey,
      legacyStorageKey,
      activePaneKey,
      runtimeKeysReady,
      validRuntimeKeys: JSON.parse(runtimeKeys) as string[],
    }),
    [storageKey, legacyStorageKey, activePaneKey, runtimeKeysReady, runtimeKeys]
  )
  const source = useMemo(() => owner.forScope(input), [owner, input])
  const subscribe = useCallback(
    (listener: () => void) => owner.observe(input, listener),
    [owner, input]
  )
  const state = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  const commit = source.commit

  const activeLayout = getActiveWorkbenchLayout(state)
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
      placeTask,
      splitMode,
      splitPane,
      state,
      updateSizes,
    ]
  )
}

export type WorkbenchSplitGroupsController = ReturnType<typeof useWorkbenchSplitGroups>
