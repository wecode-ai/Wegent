import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

vi.mock('../e2e/desktop/modules/collaboration-board-personal-view.mjs', () => ({
  openProjectBoard: async () => {},
  selectProjectBoardGrouping: async control => control.resetScroll(),
  selectProjectBoardSort: async () => {},
}))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', () => ({
  reloadMainWindow: async control => control.resetScroll(),
}))

import {
  assertLaneOrder,
  verifyReadOnlyBoardDrag,
} from '../e2e/desktop/modules/collaboration-board-field-drag.mjs'
import { assertIssueColumns } from '../e2e/desktop/modules/collaboration-board-tag-drag.mjs'

test.each([{ tags: ['drag-A', 'drag-B'] }, { tags: [] }])(
  'reveals offscreen tag cards for $tags',
  async ({ tags }) => {
    let visible = null
    const asserted = []
    const control = {
      async command(action, selector, options = {}) {
        if (action === 'scrollIntoView') visible = selector
        if (action === 'waitFor' && options.visible !== undefined) {
          const key = selector.match(/cloud-todo-column-(tag-[^"]+)/)[1]
          const present = key === 'tag-untagged' ? tags.length === 0 : tags.includes(key.slice(4))
          assert.equal(options.visible, present)
          if (present) assert.equal(visible, selector, 'The tag card is outside the viewport')
          asserted.push(key)
        }
        return ''
      },
    }
    await assertIssueColumns(control, selector => selector, 'moving', tags)
    assert.deepEqual(asserted, ['tag-drag-A', 'tag-drag-B', 'tag-drag-C', 'tag-untagged'])
  }
)

test('checks manual lane order after bringing each card into the viewport', async () => {
  let visible = null
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'scrollIntoView') visible = selector
      if (action === 'waitFor' && options.visible) assert.equal(visible, selector)
      if (action === 'getTestIdOrder')
        return JSON.stringify(['cloud-todo-card-anchor', 'cloud-todo-card-moving'])
      return ''
    },
  }
  await assertLaneOrder(control, selector => selector, 'priority-low', ['anchor', 'moving'])
  await assert.rejects(
    assertLaneOrder(control, selector => selector, 'priority-low', ['moving', 'anchor'])
  )
})

test('scrolls the Viewer card into view after grouping and reload', async () => {
  let visibleCard = null
  let mounted = false
  let drags = 0
  let reads = 0
  const control = {
    resetScroll() {
      visibleCard = null
      mounted = false
    },
    async command(action, selector, options = {}) {
      if (action === 'scrollIntoView') {
        assert.ok(mounted, 'The Viewer card has not mounted after loading the board')
        visibleCard = selector
      } else if (action === 'waitFor' && options.visible) {
        assert.equal(visibleCard, selector, 'The Viewer card is outside the viewport')
      } else if (action === 'getAttribute') return ''
      else if (action === 'drag') {
        assert.equal(visibleCard, selector)
        drags += 1
      } else {
        assert.equal(action, 'waitFor')
        if (options.visible === undefined) mounted = true
      }
      return ''
    },
  }
  await verifyReadOnlyBoardDrag(control, {
    scoped: selector => selector,
    request: async () => {
      reads += 1
      return { version: 1, sort_order: 0, status: 'inbox', priority: 'low' }
    },
    project: { id: 1 },
    issues: [{ id: 'viewer' }, { id: 'owner' }],
    reader: { id: 2 },
    owner: { id: 3 },
  })
  assert.equal(drags, 4)
  assert.equal(reads, 8)
})
