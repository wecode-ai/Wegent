import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'

import { assertIssueColumns } from '../e2e/desktop/modules/collaboration-board-tag-drag.mjs'

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
