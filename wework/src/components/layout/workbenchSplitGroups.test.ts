// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  activateWorkbenchPane,
  createWorkbenchSplitGroupsState,
  getActiveWorkbenchLayout,
  migratePersistedWorkbenchSplitLayout,
  placeActiveWorkbenchTask,
  splitActiveWorkbenchPane,
} from './workbenchSplitGroups'
import {
  collectWorkbenchPaneKeys,
  createWorkbenchLayout,
  placeWorkbenchTask,
  serializeWorkbenchLayout,
} from './workbenchSplitLayout'

const one = 'runtime:device:one'
const two = 'runtime:device:two'
const three = 'runtime:device:three'

function createGroup(oneKey = one, twoKey = two) {
  let state = createWorkbenchSplitGroupsState(oneKey)
  const paneId = getActiveWorkbenchLayout(state).focusedPaneId
  state = splitActiveWorkbenchPane(state, paneId, 'right')
  state = activateWorkbenchPane(state, twoKey)
  return state
}

describe('workbenchSplitGroups', () => {
  it('creates a draft split and fills its focused empty pane explicitly', () => {
    const state = createWorkbenchSplitGroupsState(one)
    const split = splitActiveWorkbenchPane(
      state,
      getActiveWorkbenchLayout(state).focusedPaneId,
      'right'
    )

    expect(split.activeView.type).toBe('group')
    expect(split.groups).toHaveLength(1)
    expect(split.groups[0].draft).toBe(true)
    expect(collectWorkbenchPaneKeys(split.groups[0].layout.root)).toEqual([one])

    const filled = activateWorkbenchPane(split, two)
    expect(filled.groups[0].draft).toBe(false)
    expect(collectWorkbenchPaneKeys(filled.groups[0].layout.root)).toEqual([one, two])
  })

  it('creates a group when a sidebar task is dropped on a single-pane edge', () => {
    const state = createWorkbenchSplitGroupsState(two)
    const paneId = getActiveWorkbenchLayout(state).focusedPaneId
    const grouped = placeActiveWorkbenchTask(state, one, paneId, 'right', two)

    expect(grouped.activeView.type).toBe('group')
    expect(grouped.groups).toHaveLength(1)
    expect(grouped.groups[0].draft).toBe(false)
    expect(collectWorkbenchPaneKeys(grouped.groups[0].layout.root)).toEqual([two, one])
  })

  it('switches to an unrelated single task without mutating the saved group', () => {
    const grouped = createGroup()
    const single = activateWorkbenchPane(grouped, three)

    expect(single.activeView.type).toBe('single')
    expect(collectWorkbenchPaneKeys(single.groups[0].layout.root)).toEqual([one, two])
    expect(collectWorkbenchPaneKeys(getActiveWorkbenchLayout(single).root)).toEqual([three])
  })

  it('migrates an existing v2 multi-pane layout into split group one', () => {
    const initial = createWorkbenchLayout(one)
    const layout = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'right')
    const migrated = migratePersistedWorkbenchSplitLayout(serializeWorkbenchLayout(layout), one)

    expect(migrated?.groups).toEqual([
      expect.objectContaining({
        displayNumber: 1,
        draft: false,
        layout,
      }),
    ])
    expect(migrated?.activeView.type).toBe('group')
  })
})
