import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createWorkbenchSplitGroupsState,
  getActiveWorkbenchLayout,
  serializeWorkbenchSplitGroups,
} from './workbenchSplitGroups'
import { collectWorkbenchPaneKeys } from './workbenchSplitLayout'
import { useWorkbenchSplitGroups } from './useWorkbenchSplitGroups'

const storageKey = 'workbench-split-groups-test'
const legacyStorageKey = 'workbench-split-layout-test'
const restoredRuntimePaneKey = 'runtime:device:finished-task'

function activePaneKeys(state: ReturnType<typeof useWorkbenchSplitGroups>['state']) {
  return collectWorkbenchPaneKeys(getActiveWorkbenchLayout(state).root)
}

describe('useWorkbenchSplitGroups', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(
      storageKey,
      serializeWorkbenchSplitGroups(createWorkbenchSplitGroupsState(restoredRuntimePaneKey))
    )
  })

  it('keeps a restored runtime pane while the startup active pane is still blank', async () => {
    const { result, rerender } = renderHook(
      ({ activePaneKey, runtimeKeysReady }) =>
        useWorkbenchSplitGroups({
          storageKey,
          legacyStorageKey,
          activePaneKey,
          validRuntimeKeys: runtimeKeysReady ? [restoredRuntimePaneKey] : [],
          runtimeKeysReady,
        }),
      {
        initialProps: {
          activePaneKey: 'blank:0',
          runtimeKeysReady: false,
        },
      }
    )

    expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])

    rerender({
      activePaneKey: 'blank:0',
      runtimeKeysReady: true,
    })

    await waitFor(() =>
      expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])
    )
  })

  it('keeps a restored runtime pane when startup advances to another blank pane', async () => {
    const { result, rerender } = renderHook(
      ({ activePaneKey }) =>
        useWorkbenchSplitGroups({
          storageKey,
          legacyStorageKey,
          activePaneKey,
          validRuntimeKeys: [restoredRuntimePaneKey],
          runtimeKeysReady: true,
        }),
      {
        initialProps: {
          activePaneKey: 'blank:0',
        },
      }
    )

    expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])

    rerender({ activePaneKey: 'blank:1' })

    await waitFor(() =>
      expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])
    )
  })

  it('opens a fresh blank pane after leaving an active runtime task', async () => {
    const { result, rerender } = renderHook(
      ({ activePaneKey }) =>
        useWorkbenchSplitGroups({
          storageKey,
          legacyStorageKey,
          activePaneKey,
          validRuntimeKeys: [restoredRuntimePaneKey],
          runtimeKeysReady: true,
        }),
      {
        initialProps: {
          activePaneKey: restoredRuntimePaneKey,
        },
      }
    )

    expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])

    rerender({ activePaneKey: 'blank:1' })

    await waitFor(() => expect(activePaneKeys(result.current.state)).toEqual(['blank:1']))
  })

  it('loads the persisted layout when the workspace tab storage scope becomes available', async () => {
    const bootstrapStorageKey = 'workbench-split-groups-bootstrap'
    const restoredStorageKey = 'workbench-split-groups-fixed-task'
    localStorage.setItem(
      restoredStorageKey,
      serializeWorkbenchSplitGroups(createWorkbenchSplitGroupsState(restoredRuntimePaneKey))
    )

    const { result, rerender } = renderHook(
      ({ currentStorageKey, runtimeKeysReady }) =>
        useWorkbenchSplitGroups({
          storageKey: currentStorageKey,
          legacyStorageKey,
          activePaneKey: 'blank:0',
          validRuntimeKeys: runtimeKeysReady ? [restoredRuntimePaneKey] : [],
          runtimeKeysReady,
        }),
      {
        initialProps: {
          currentStorageKey: bootstrapStorageKey,
          runtimeKeysReady: false,
        },
      }
    )

    expect(activePaneKeys(result.current.state)).toEqual(['blank:0'])

    rerender({
      currentStorageKey: restoredStorageKey,
      runtimeKeysReady: true,
    })

    await waitFor(() =>
      expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])
    )
    expect(localStorage.getItem(restoredStorageKey)).toContain(restoredRuntimePaneKey)
    expect(localStorage.getItem(restoredStorageKey)).not.toContain('blank:0')
  })

  it('isolates delayed updates from the previous workspace tab storage scope', async () => {
    const bootstrapStorageKey = 'workbench-split-groups-bootstrap'
    const restoredStorageKey = 'workbench-split-groups-fixed-task'
    localStorage.setItem(
      restoredStorageKey,
      serializeWorkbenchSplitGroups(createWorkbenchSplitGroupsState(restoredRuntimePaneKey))
    )

    const { result, rerender } = renderHook(
      ({ currentStorageKey }) =>
        useWorkbenchSplitGroups({
          storageKey: currentStorageKey,
          legacyStorageKey,
          activePaneKey: 'blank:0',
          validRuntimeKeys: [restoredRuntimePaneKey],
          runtimeKeysReady: true,
        }),
      {
        initialProps: {
          currentStorageKey: bootstrapStorageKey,
        },
      }
    )
    const bootstrapController = result.current

    rerender({ currentStorageKey: restoredStorageKey })

    await waitFor(() =>
      expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])
    )

    act(() => {
      bootstrapController.activatePane('blank:delayed-bootstrap')
    })

    expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])
    expect(localStorage.getItem(restoredStorageKey)).toContain(restoredRuntimePaneKey)
    expect(localStorage.getItem(restoredStorageKey)).not.toContain('blank:delayed-bootstrap')
  })

  it('replaces a stale persisted blank pane with the current startup blank pane', async () => {
    localStorage.setItem(
      storageKey,
      serializeWorkbenchSplitGroups(createWorkbenchSplitGroupsState('blank:1'))
    )

    const { result } = renderHook(() =>
      useWorkbenchSplitGroups({
        storageKey,
        legacyStorageKey,
        activePaneKey: 'blank:2',
        validRuntimeKeys: [restoredRuntimePaneKey],
        runtimeKeysReady: true,
      })
    )

    await waitFor(() => expect(activePaneKeys(result.current.state)).toEqual(['blank:2']))
  })

  it('activates an initial runtime pane over a different persisted runtime pane', async () => {
    const currentRuntimePaneKey = 'runtime:device:current-task'

    const { result } = renderHook(() =>
      useWorkbenchSplitGroups({
        storageKey,
        legacyStorageKey,
        activePaneKey: currentRuntimePaneKey,
        validRuntimeKeys: [restoredRuntimePaneKey, currentRuntimePaneKey],
        runtimeKeysReady: true,
      })
    )

    await waitFor(() =>
      expect(activePaneKeys(result.current.state)).toEqual([currentRuntimePaneKey])
    )
  })

  it('opens the current blank pane after explicit navigation', async () => {
    const { result } = renderHook(() =>
      useWorkbenchSplitGroups({
        storageKey,
        legacyStorageKey,
        activePaneKey: 'blank:0',
        validRuntimeKeys: [restoredRuntimePaneKey],
        runtimeKeysReady: true,
      })
    )

    act(() => {
      result.current.activatePane('blank:0')
    })

    await waitFor(() => expect(activePaneKeys(result.current.state)).toEqual(['blank:0']))
  })

  it('keeps an unobserved restored runtime pane when the first task list is transiently empty', async () => {
    const { result, rerender } = renderHook(
      ({ runtimeKeysReady }) =>
        useWorkbenchSplitGroups({
          storageKey,
          legacyStorageKey,
          activePaneKey: 'blank:0',
          validRuntimeKeys: [],
          runtimeKeysReady,
        }),
      {
        initialProps: {
          runtimeKeysReady: false,
        },
      }
    )

    rerender({ runtimeKeysReady: true })

    await waitFor(() =>
      expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])
    )

    act(() => {
      expect(localStorage.getItem(storageKey)).toContain(restoredRuntimePaneKey)
    })
  })

  it('removes a runtime pane after its observed task disappears', async () => {
    const { result, rerender } = renderHook(
      ({ validRuntimeKeys }) =>
        useWorkbenchSplitGroups({
          storageKey,
          legacyStorageKey,
          activePaneKey: 'blank:0',
          validRuntimeKeys,
          runtimeKeysReady: true,
        }),
      {
        initialProps: {
          validRuntimeKeys: [restoredRuntimePaneKey],
        },
      }
    )

    expect(activePaneKeys(result.current.state)).toEqual([restoredRuntimePaneKey])

    rerender({ validRuntimeKeys: [] })

    await waitFor(() => expect(activePaneKeys(result.current.state)).toEqual(['blank:0']))
  })
})
