import { describe, expect, it } from 'vitest'
import {
  closeWorkbenchPane,
  collectWorkbenchPanes,
  createWorkbenchLayout,
  focusWorkbenchTask,
  openWorkbenchPane,
  parsePersistedWorkbenchLayout,
  placeWorkbenchTask,
  pruneWorkbenchLayout,
  serializeWorkbenchLayout,
  splitWorkbenchPane,
  updateWorkbenchSplitSizes,
} from './workbenchSplitLayout'

const one = 'runtime:device:one'
const two = 'runtime:device:two'
const three = 'runtime:device:three'

describe('workbenchSplitLayout', () => {
  it('replaces the focused pane when sidebar navigation opens a new task', () => {
    const initial = createWorkbenchLayout(one)
    const next = openWorkbenchPane(initial, two)

    expect(collectWorkbenchPanes(next.root).map(pane => pane.paneKey)).toEqual([two])
    expect(next.focusedPaneId).toBe(initial.focusedPaneId)
  })

  it('focuses an already visible task without duplicating or moving it', () => {
    const initial = createWorkbenchLayout(one)
    const split = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'right')
    const next = openWorkbenchPane(split, one)

    expect(collectWorkbenchPanes(next.root).map(pane => pane.paneKey)).toEqual([one, two])
    expect(
      collectWorkbenchPanes(next.root).find(pane => pane.id === next.focusedPaneId)?.paneKey
    ).toBe(one)
  })

  it('creates one empty pane and fills it on the next sidebar navigation', () => {
    const initial = createWorkbenchLayout(one)
    const split = splitWorkbenchPane(initial, initial.focusedPaneId, 'right')

    expect(collectWorkbenchPanes(split.root).map(pane => pane.paneKey)).toEqual([one, null])

    const filled = openWorkbenchPane(split, two)
    expect(collectWorkbenchPanes(filled.root).map(pane => pane.paneKey)).toEqual([one, two])
  })

  it('places a sidebar task on an edge with one task per pane', () => {
    const initial = createWorkbenchLayout(one)
    const next = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'left')

    expect(collectWorkbenchPanes(next.root).map(pane => pane.paneKey)).toEqual([two, one])
    expect(
      collectWorkbenchPanes(next.root).find(pane => pane.id === next.focusedPaneId)?.paneKey
    ).toBe(two)
  })

  it('moves an existing task between panes instead of retaining a hidden copy', () => {
    const initial = createWorkbenchLayout(one)
    const split = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'right')
    const [left, right] = collectWorkbenchPanes(split.root)
    const moved = placeWorkbenchTask(split, one, right.id, 'down')

    expect(collectWorkbenchPanes(moved.root).map(pane => pane.paneKey)).toEqual([two, one])
    expect(collectWorkbenchPanes(moved.root).some(pane => pane.id === left.id)).toBe(false)
  })

  it('replaces the target task when dropped in the center', () => {
    const initial = createWorkbenchLayout(one)
    const split = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'right')
    const right = collectWorkbenchPanes(split.root)[1]
    const next = placeWorkbenchTask(split, three, right.id, 'center')

    expect(collectWorkbenchPanes(next.root).map(pane => pane.paneKey)).toEqual([one, three])
  })

  it('automatically removes a pane when its task closes', () => {
    const initial = createWorkbenchLayout(one)
    const split = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'right')
    const right = collectWorkbenchPanes(split.root)[1]
    const closed = closeWorkbenchPane(split, right.id)

    expect(collectWorkbenchPanes(closed.root).map(pane => pane.paneKey)).toEqual([one])
  })

  it('keeps one empty root pane when the last task closes', () => {
    const initial = createWorkbenchLayout(one)
    const closed = closeWorkbenchPane(initial, initial.focusedPaneId)

    expect(collectWorkbenchPanes(closed.root)).toEqual([
      expect.objectContaining({ id: initial.focusedPaneId, paneKey: null }),
    ])
  })

  it('prunes invalid runtime tasks and collapses their split', () => {
    const initial = createWorkbenchLayout(one)
    const split = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'right')
    const pruned = pruneWorkbenchLayout(split, new Set([one]))

    expect(pruned).not.toBeNull()
    expect(collectWorkbenchPanes(pruned!.root).map(pane => pane.paneKey)).toEqual([one])
  })

  it('preserves an intentionally empty split while runtime tasks are valid', () => {
    const initial = createWorkbenchLayout(one)
    const split = splitWorkbenchPane(initial, initial.focusedPaneId, 'right')
    const pruned = pruneWorkbenchLayout(split, new Set([one]))

    expect(collectWorkbenchPanes(pruned!.root).map(pane => pane.paneKey)).toEqual([one, null])
  })

  it('persists v2 layouts and rejects the obsolete tabbed v1 shape', () => {
    const initial = createWorkbenchLayout(one)
    const split = placeWorkbenchTask(initial, two, initial.focusedPaneId, 'right')
    const resized = updateWorkbenchSplitSizes(split, split.root.id, {
      [collectWorkbenchPanes(split.root)[0].id]: 35,
      [collectWorkbenchPanes(split.root)[1].id]: 65,
    })

    expect(parsePersistedWorkbenchLayout(serializeWorkbenchLayout(resized))).toEqual(resized)
    expect(
      parsePersistedWorkbenchLayout(
        JSON.stringify({ version: 1, layout: { version: 1, root: {} } })
      )
    ).toBeNull()
  })

  it('returns null when focusing a task outside the layout', () => {
    expect(focusWorkbenchTask(createWorkbenchLayout(one), two)).toBeNull()
  })
})
