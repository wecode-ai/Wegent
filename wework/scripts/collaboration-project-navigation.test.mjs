// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import {
  selectCollaborationProjectView,
  waitForLocalProjectNavigation,
} from '../e2e/desktop/modules/collaboration-project-navigation.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const NAME = 'Selected project'

function fixture(compact, options = {}) {
  let view = 'manage'
  const command = vi.fn(async (action, selector, input = {}) => {
    if (action === 'getElementCount') return compact ? '1' : '0'
    if (action === 'waitFor') {
      assert.equal(input.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
      if (selector.includes(':has(')) {
        assert.equal(input.visible, true)
        assert.ok(selector.includes(':not(:has('))
        assert.ok(selector.includes('[aria-current="page"]'))
        if (compact)
          assert.equal(
            options.selectedProject ?? NAME,
            input.text,
            'Wrong selected sidebar project'
          )
        else assert.equal(options.titleVisible ?? true, true, 'Title is hidden')
      } else if (selector.includes('cloud-project-header-title')) {
        assert.equal(options.title ?? NAME, input.text, 'Wrong active project title')
        if (input.visible) assert.equal(options.titleVisible ?? !compact, true, 'Title is hidden')
      } else if (selector.includes('aria-current="page"')) {
        assert.equal(options.selectedProject ?? NAME, input.text, 'Wrong selected sidebar project')
        assert.equal(input.visible, true)
      } else if (selector.includes('collaboration-project-view-select')) {
        assert.equal(compact, true)
        assert.equal(options.navigationVisible ?? true, true, 'Navigation is hidden')
        assert.equal(options.navigationEnabled ?? true, true, 'Navigation is disabled')
        assert.equal(input.visible, true)
        assert.equal(input.enabled, true)
      } else if (selector.includes('collaboration-board')) {
        assert.equal(view, 'board')
        assert.equal(options.boardVisible ?? true, true, 'Board has not rendered')
        assert.equal(input.visible, true)
      } else assert.fail(`Unexpected wait: ${selector}`)
      return ''
    }
    if (action === 'chooseWhenEnabled') {
      assert.equal(options.navigationVisible ?? true, true, 'Navigation is hidden')
      assert.equal(options.navigationEnabled ?? true, true, 'Navigation is disabled')
      assert.equal(input.visible, true)
      assert.equal(input.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
      const tabs = {
        'collaboration-tab-board': 'board',
        'collaboration-tab-table': 'table',
        'collaboration-tab-manage': 'manage',
        'collaboration-tab-files': 'files',
        'collaboration-gantt-tab': 'gantt',
        'collaboration-calendar-tab': 'calendar',
        'collaboration-milestones-tab': 'milestones',
      }
      const id = Object.keys(tabs).find(id => tabs[id] === input.value)
      assert.ok(id, `Wide layout does not render ${input.value}`)
      assert.equal(
        selector,
        `${CONTENT} [data-testid="collaboration-project-view-select"], ${CONTENT} [data-testid="${id}"]`
      )
      assert.ok(
        (
          options.views ?? ['board', 'table', 'manage', 'gantt', 'files', 'calendar', 'milestones']
        ).includes(input.value),
        'View is unavailable'
      )
      view = input.value
      return view
    }
    assert.fail(`Unexpected action: ${action}`)
  })
  return {
    command,
    get view() {
      return view
    },
  }
}

test.each([false, true])(
  'retains project identity and visible board readiness, compact=%s',
  async compact => {
    const control = fixture(compact)
    await waitForLocalProjectNavigation(control, CONTENT, NAME)
    assert.equal(control.view, 'board')
    assert.ok(
      control.command.mock.calls.some(
        ([action, selector, options]) =>
          action === 'waitFor' &&
          selector.includes('cloud-project-header-title') &&
          options.text === NAME
      )
    )
  }
)

for (const view of ['board', 'manage', 'table', 'gantt', 'files', 'calendar', 'milestones']) {
  test.each([false, true])(
    `selects ${view} through the actual layout, compact=%s`,
    async compact => {
      const control = fixture(compact)
      await selectCollaborationProjectView(control, CONTENT, view)
      assert.equal(control.view, view)
    }
  )
}

test('wide layout still requires a visible project title', async () => {
  await assert.rejects(
    waitForLocalProjectNavigation(fixture(false, { titleVisible: false }), CONTENT, NAME),
    /Title is hidden/
  )
})

test('compact layout rejects a stale hidden title and the wrong selected project', async () => {
  await assert.rejects(
    waitForLocalProjectNavigation(fixture(true, { title: 'Other' }), CONTENT, NAME),
    /Wrong active project title/
  )
  await assert.rejects(
    waitForLocalProjectNavigation(fixture(true, { selectedProject: 'Other' }), CONTENT, NAME),
    /Wrong selected sidebar project/
  )
})

test('compact layout still requires visible, enabled navigation and rendered board content', async () => {
  await assert.rejects(
    waitForLocalProjectNavigation(fixture(true, { navigationEnabled: false }), CONTENT, NAME),
    /Navigation is disabled/
  )
  await assert.rejects(
    waitForLocalProjectNavigation(fixture(true, { navigationVisible: false }), CONTENT, NAME),
    /Navigation is hidden/
  )
  await assert.rejects(
    waitForLocalProjectNavigation(fixture(true, { boardVisible: false }), CONTENT, NAME),
    /Board has not rendered/
  )
})

test('wide layout also rejects hidden navigation and compact layouts cannot select an unavailable view', async () => {
  await assert.rejects(
    waitForLocalProjectNavigation(fixture(false, { navigationVisible: false }), CONTENT, NAME),
    /Navigation is hidden/
  )
  await assert.rejects(
    selectCollaborationProjectView(fixture(true, { views: ['board'] }), CONTENT, 'manage'),
    /View is unavailable/
  )
})
