// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  collectWorkbenchPanes,
  createWorkbenchLayout,
  parsePersistedWorkbenchLayout,
  placeWorkbenchTask,
  serializeWorkbenchLayout,
  updateWorkbenchSplitSizes,
} from './workbenchSplitLayout'

const one = 'runtime:device:one'
const two = 'runtime:device:two'

describe('workbenchSplitLayout', () => {
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
})
