import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'

import {
  assertIssueColumns,
  verifyMultiTagBoardDrag,
} from '../e2e/desktop/modules/collaboration-board-tag-drag.mjs'
import { assertLaneOrder } from '../e2e/desktop/modules/collaboration-board-field-drag.mjs'

afterEach(() => vi.useRealTimers())

const scoped = selector => `[data-workspace-tab-content][aria-hidden="false"] ${selector}`

function boardControl(tags, unexpectedColumn = null) {
  const scrolled = new Set()
  return {
    scrolled,
    async command(action, selector, options) {
      const key = selector.match(/cloud-todo-column-([^"\]]+)/)[1]
      const belongs = key === 'tag-untagged' ? tags.length === 0 : tags.includes(key.slice(4))
      if (action === 'getElementCount') return belongs || key === unexpectedColumn ? '1' : '0'
      if (action === 'scrollIntoView') {
        assert.ok(belongs, 'Only an existing column card can be scrolled into view')
        scrolled.add(key)
        return ''
      }
      assert.equal(action, 'waitFor')
      assert.equal(options.visible, true)
      assert.ok(
        scrolled.has(key),
        'The offscreen card must be scrolled before waiting for visibility'
      )
      return ''
    },
  }
}

test.each([{ tags: [] }, { tags: ['drag-A'] }, { tags: ['drag-A', 'drag-B'] }])(
  'checks column membership and reveals offscreen cards for $tags',
  async ({ tags }) => {
    const control = boardControl(tags)

    await assertIssueColumns(control, scoped, 'issue-1', tags, 1000)

    assert.deepEqual(
      [...control.scrolled],
      tags.length ? tags.map(tag => `tag-${tag}`) : ['tag-untagged']
    )
  }
)

test('rejects an unexpected offscreen card instead of treating it as absent', async () => {
  vi.useFakeTimers()
  const control = boardControl(['drag-A'], 'tag-drag-B')

  const rejected = expect(
    assertIssueColumns(control, scoped, 'issue-1', ['drag-A'], 10)
  ).rejects.toThrow('Issue issue-1 has incorrect column membership')
  await vi.runAllTimersAsync()

  await rejected
})

test('checks the whole column set again when cards finish loading during a poll', async () => {
  vi.useFakeTimers()
  const control = boardControl(['drag-B'], 'tag-drag-A')
  const loadedCommand = control.command.bind(control)
  let loading = true
  control.command = async (action, selector, options) => {
    if (action === 'getElementCount' && loading) {
      loading = false
      return '0'
    }
    return loadedCommand(action, selector, options)
  }

  const rejected = expect(
    assertIssueColumns(control, scoped, 'issue-1', ['drag-B'], 200)
  ).rejects.toThrow('Issue issue-1 has incorrect column membership')
  await vi.runAllTimersAsync()

  await rejected
})

test.each([
  ['persisted order', ['moving', 'anchor'], false],
  ['incorrect order', ['anchor', 'moving'], true],
])('reveals reloaded offscreen lane cards and checks %s', async (_label, order, rejects) => {
  const scrolled = new Set()
  const control = {
    async command(action, selector, options) {
      if (action === 'getTestIdOrder') {
        return JSON.stringify(order.map(id => `cloud-todo-card-${id}`))
      }
      if (action === 'scrollIntoView') {
        scrolled.add(selector)
        return ''
      }
      assert.equal(action, 'waitFor')
      if (options?.visible === true) {
        assert.ok(scrolled.has(selector), 'A reloaded offscreen card must be revealed first')
      }
      return ''
    },
  }
  const result = assertLaneOrder(control, scoped, 'priority-low', ['moving', 'anchor'])

  if (rejects) await assert.rejects(result, assert.AssertionError)
  else await result
  assert.equal(scrolled.size, 2, 'The order assertion must still check every required card')
})

test('restores the owner window when creating its narrow board fixture fails', async () => {
  const previous = { width: 1440, height: 900 }
  const command = vi.fn(async () => JSON.stringify(previous))
  const failure = new Error('The fixture project could not be created')
  const request = vi.fn().mockRejectedValue(failure)

  await assert.rejects(
    verifyMultiTagBoardDrag(
      { command },
      { scoped, request, project: { workspace_id: 7 }, uiTimeoutMs: 1000 }
    ),
    error => error === failure
  )
  assert.deepEqual(command.mock.calls, [
    ['setMainWindowSize', 'body', { value: JSON.stringify({ width: 1024, height: 720 }) }],
    ['setMainWindowSize', 'body', { value: JSON.stringify(previous) }],
  ])
})
