import { describe, expect, it } from 'vitest'
import {
  collectWorkbenchPaneKeys,
  collectWorkbenchPanes,
  createWorkbenchLayout,
  placeWorkbenchTask,
  serializeWorkbenchLayout,
} from './workbenchSplitLayout'
import {
  activateWorkbenchPane,
  closeActiveWorkbenchPane,
  createWorkbenchSplitGroupsState,
  getActiveWorkbenchLayout,
  getWorkbenchSplitGroupMemberships,
  migratePersistedWorkbenchSplitLayout,
  parsePersistedWorkbenchSplitGroups,
  placeActiveWorkbenchTask,
  pruneWorkbenchSplitGroups,
  serializeWorkbenchSplitGroups,
  splitActiveWorkbenchPane,
} from './workbenchSplitGroups'

const one = 'runtime:device:one'
const two = 'runtime:device:two'
const three = 'runtime:device:three'
const four = 'runtime:device:four'

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

  it('restores the complete group and focuses the clicked member', () => {
    const grouped = createGroup()
    const single = activateWorkbenchPane(grouped, three)
    const restored = activateWorkbenchPane(single, one)
    const layout = getActiveWorkbenchLayout(restored)

    expect(restored.activeView).toEqual({ type: 'group', groupId: restored.groups[0].id })
    expect(collectWorkbenchPaneKeys(layout.root)).toEqual([one, two])
    expect(
      collectWorkbenchPanes(layout.root).find(pane => pane.id === layout.focusedPaneId)?.paneKey
    ).toBe(one)
  })

  it('keeps multiple numbered groups and one membership per task', () => {
    let state = createGroup()
    state = activateWorkbenchPane(state, three)
    state = splitActiveWorkbenchPane(state, getActiveWorkbenchLayout(state).focusedPaneId, 'right')
    state = activateWorkbenchPane(state, four)

    expect(state.groups.map(group => group.displayNumber)).toEqual([1, 2])
    expect(getWorkbenchSplitGroupMemberships(state)).toMatchObject({
      [one]: { displayNumber: 1, active: false },
      [two]: { displayNumber: 1, active: false },
      [three]: { displayNumber: 2, active: true },
      [four]: { displayNumber: 2, active: true },
    })

    const target = collectWorkbenchPanes(getActiveWorkbenchLayout(state).root)[1]
    state = placeActiveWorkbenchTask(state, one, target.id, 'right', four)

    const memberships = getWorkbenchSplitGroupMemberships(state)
    expect(memberships[one].displayNumber).toBe(2)
    expect(state.groups.some(group => group.displayNumber === 1)).toBe(false)
  })

  it('dissolves a group after closing it down to one conversation', () => {
    const grouped = createGroup()
    const rightPane = collectWorkbenchPanes(getActiveWorkbenchLayout(grouped).root)[1]
    const closed = closeActiveWorkbenchPane(grouped, rightPane.id, one)

    expect(closed.groups).toEqual([])
    expect(closed.activeView.type).toBe('single')
    expect(collectWorkbenchPaneKeys(getActiveWorkbenchLayout(closed).root)).toEqual([one])
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

  it('round-trips multiple persisted groups', () => {
    let state = createGroup()
    state = activateWorkbenchPane(state, three)
    state = splitActiveWorkbenchPane(state, getActiveWorkbenchLayout(state).focusedPaneId, 'right')
    state = activateWorkbenchPane(state, four)

    expect(parsePersistedWorkbenchSplitGroups(serializeWorkbenchSplitGroups(state), three)).toEqual(
      state
    )
  })

  it('falls back to a single pane when the persisted active group is missing', () => {
    const state = createGroup()
    const parsed = parsePersistedWorkbenchSplitGroups(
      serializeWorkbenchSplitGroups({
        ...state,
        activeView: { type: 'group', groupId: 'missing-group' },
      }),
      three
    )

    expect(parsed?.activeView.type).toBe('single')
    expect(parsed && collectWorkbenchPaneKeys(getActiveWorkbenchLayout(parsed).root)).toEqual([
      three,
    ])
  })

  it('drops invalid persisted groups while preserving valid groups', () => {
    const state = createGroup()
    const invalidGroup = {
      ...state.groups[0],
      id: 'invalid-group',
      layout: {
        ...state.groups[0].layout,
        root: {
          ...state.groups[0].layout.root,
          children: [],
        },
      },
    }
    const parsed = parsePersistedWorkbenchSplitGroups(
      serializeWorkbenchSplitGroups({
        ...state,
        groups: [...state.groups, invalidGroup],
      }),
      one
    )

    expect(parsed?.groups).toEqual(state.groups)
  })

  it('prunes restored groups whose conversations no longer exist', () => {
    let state = createGroup()
    state = activateWorkbenchPane(state, three)
    state = splitActiveWorkbenchPane(state, getActiveWorkbenchLayout(state).focusedPaneId, 'right')
    state = activateWorkbenchPane(state, four)
    const restored = parsePersistedWorkbenchSplitGroups(serializeWorkbenchSplitGroups(state), three)

    const pruned = pruneWorkbenchSplitGroups(restored!, new Set([three, four]), three)

    expect(pruned.groups).toHaveLength(1)
    expect(collectWorkbenchPaneKeys(pruned.groups[0].layout.root)).toEqual([three, four])
    expect(pruned.activeView).toEqual({
      type: 'group',
      groupId: pruned.groups[0].id,
    })
  })
})
