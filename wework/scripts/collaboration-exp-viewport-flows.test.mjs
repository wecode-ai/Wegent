import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDesktopPanes } from '../e2e/desktop/modules/collaboration-exp-pane-verification.mjs'
import {
  assertMobileAssistantPriority,
  assertMobileNavigation,
  assertReducedPlanMotion,
} from '../e2e/desktop/modules/collaboration-exp-state-motion.mjs'
import {
  selectCollaborationExpAppearance,
  verifyCollaborationExpViewports,
} from '../e2e/desktop/modules/collaboration-exp-viewport-flows.mjs'

const testId = id => `app [data-testid="${id}"]`
const box = { left: 0, top: 0, width: 300, height: 60 }

const experimentRoute =
  '/collaboration-exp?view=tasks&projectScope=%5B%22local%22%2C%22project%22%5D&projectStore=local&projectId=project&issueId=issue&discussion=owned-task&future=keep'

function appearanceControl({ mode = 'light', ignoreSelection = false } = {}) {
  const calls = []
  const state = {
    mode,
    nativeMode: mode,
    route: experimentRoute,
  }
  return {
    calls,
    state,
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'setAppPreferences') {
        state.nativeMode = JSON.parse(options.value).appearanceMode
      } else if (action === 'navigate') {
        state.route = options.value
      } else if (action === 'clickWhenEnabled') {
        assert.equal(state.route, '/settings/appearance')
        assert.match(selector, /^\[data-testid="appearance-mode-(light|dark)"\]$/)
        if (!ignoreSelection) state.mode = selector.includes('mode-dark') ? 'dark' : 'light'
      } else if (action === 'waitFor' && selector.startsWith('html')) {
        assert.equal(selector, `html[data-theme="${state.mode}"]`, 'Root theme did not change')
      } else if (action === 'waitFor') {
        assert.equal(selector, '[data-testid="appearance-settings-page"]')
        assert.equal(state.route, '/settings/appearance')
      } else assert.fail(`Unexpected appearance operation: ${action} ${selector}`)
      return ''
    },
  }
}

test('viewport appearance uses the enabled settings control and returns the complete experiment query', async () => {
  for (const mode of ['light', 'dark']) {
    const control = appearanceControl({ mode: mode === 'dark' ? 'light' : 'dark' })
    await selectCollaborationExpAppearance(control, mode, experimentRoute)
    assert.equal(control.state.mode, mode)
    assert.equal(control.state.route, experimentRoute)
    assert.deepEqual(control.calls, [
      { action: 'navigate', selector: 'body', options: { value: '/settings/appearance' } },
      {
        action: 'waitFor',
        selector: '[data-testid="appearance-settings-page"]',
        options: { visible: true },
      },
      {
        action: 'clickWhenEnabled',
        selector: `[data-testid="appearance-mode-${mode}"]`,
        options: undefined,
      },
      { action: 'waitFor', selector: `html[data-theme="${mode}"]`, options: undefined },
      { action: 'navigate', selector: 'body', options: { value: experimentRoute } },
    ])
  }
})

test('native preference persistence cannot stand in for the main window appearance setting', async () => {
  const control = appearanceControl()
  await control.command('setAppPreferences', 'body', {
    value: JSON.stringify({ appearanceMode: 'dark' }),
  })
  assert.equal(control.state.nativeMode, 'dark')
  assert.equal(control.state.mode, 'light')
  await assert.rejects(() => control.command('waitFor', 'html[data-theme="dark"]'))
  await selectCollaborationExpAppearance(control, 'dark', experimentRoute)
  assert.equal(control.state.mode, 'dark')
})

test('viewport appearance still rejects a settings selection that fails to update the root theme', async () => {
  const control = appearanceControl({ ignoreSelection: true })
  await assert.rejects(
    () => selectCollaborationExpAppearance(control, 'dark', experimentRoute),
    /Root theme did not change/
  )
  assert.equal(control.state.route, '/settings/appearance')
})

function mobilePriorityControl(change = {}) {
  const first = {
    ...box,
    top: 250,
    bottom: 400,
    height: 150,
    visibleIntersection: { height: 150 },
    ...change.first,
  }
  return {
    async command(action, selector) {
      if (action === 'waitFor') return ''
      assert.equal(action, 'getElementMetrics')
      if (selector === testId('collaboration-exp-assistant-input'))
        return JSON.stringify([{ ...box, top: 500 }])
      if (selector === 'running-role')
        return JSON.stringify([
          { ...box, top: 150, bottom: 210, visibleIntersection: { height: 60 } },
        ])
      if (
        selector === `${testId('collaboration-exp-assistant-decisions')} .assistant-decision-card`
      )
        return JSON.stringify(
          change.noDecisions
            ? []
            : [first, { ...first, top: 600, bottom: 750, visibleIntersection: { height: 0 } }]
        )
      if (selector === testId('collaboration-exp-assistant-snapshot'))
        return JSON.stringify([{ ...box, height: change.snapshotHeight ?? 0 }])
      assert.fail(`Unexpected mobile priority selector: ${selector}`)
    },
  }
}

test('mobile assistant priority verifies the first displayed decision while later decisions may scroll', async () => {
  await assertMobileAssistantPriority(mobilePriorityControl(), testId, 'running-role')
})

test('mobile assistant priority still rejects a clipped first decision or an expanded desktop snapshot', async () => {
  for (const [change, message] of [
    [{ first: { bottom: 520 } }, /must precede the composer/],
    [{ first: { visibleIntersection: { height: 100 } } }, /must fit in the first screen/],
    [{ snapshotHeight: 100 }, /desktop work snapshot must collapse/],
    [{ noDecisions: true }, /requires a real visible state control/],
  ])
    await assert.rejects(
      () => assertMobileAssistantPriority(mobilePriorityControl(change), testId, 'running-role'),
      message
    )
})

function mobileNavigationControl(change = {}) {
  return {
    async command(action, selector) {
      if (action === 'waitFor') return ''
      assert.equal(action, 'getElementMetrics')
      const label = selector.endsWith(' .truncate')
      return JSON.stringify([
        label
          ? {
              ...box,
              text: 'Account',
              height: 16,
              clientHeight: change.labelClientHeight ?? 16,
              scrollHeight: 16,
              visibleIntersection: { height: change.labelIntersection ?? 16 },
            }
          : {
              ...box,
              height: change.buttonHeight ?? 52,
              visibleIntersection: { height: change.buttonIntersection ?? 52 },
            },
      ])
    },
  }
}

test('mobile navigation keeps controls and their full text visible', async () => {
  await assertMobileNavigation(mobileNavigationControl(), testId)
  for (const [change, message] of [
    [{ labelClientHeight: 8 }, /labels must not clip vertically/],
    [{ labelIntersection: 8 }, /labels must fit in the viewport/],
    [{ buttonHeight: 40 }, /navigation must remain usable/],
    [{ buttonIntersection: 40 }, /controls must fit in the viewport/],
  ])
    await assert.rejects(
      () => assertMobileNavigation(mobileNavigationControl(change), testId),
      message
    )
})

function paneControl(change = {}) {
  const calls = []
  let widths = [560, 520]
  return {
    calls,
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getElementMetrics') {
        if (selector === 'app .experience-header, app .experience-task-toolbar')
          return JSON.stringify(Array.from({ length: change.headers ?? 3 }, () => box))
        if (selector.includes('pane-header-')) return JSON.stringify([box])
        if (selector.includes('[role="separator"]'))
          return JSON.stringify(Array.from({ length: 3 }, () => ({ ...box, width: 8 })))
        if (selector.includes('#collaboration-exp-resize-'))
          return JSON.stringify(change.missingBoundary ? [] : [{ ...box, width: 8 }])
        if (selector === testId('collaboration-exp-pane-timeline'))
          return JSON.stringify([{ ...box, width: widths[0] }])
        if (selector === testId('collaboration-exp-pane-discussion'))
          return JSON.stringify([{ ...box, width: widths[1] }])
        assert.fail(`Unexpected metrics selector: ${selector}`)
      }
      if (action === 'press')
        widths = options.key === 'ArrowRight' ? [widths[0] + 16, widths[1] - 16] : [600, 480]
      if (action === 'doubleClick' && !change.resetDisabled) widths = [600, 480]
      if (action === 'dragStart') widths = [640, 440]
      if (action === 'getValue') return change.draft ?? 'Unsent private draft'
      return ''
    },
  }
}

test('desktop verification owns the actual task toolbar and preserves all resize interactions', async () => {
  assert.equal(typeof verifyCollaborationExpViewports, 'function')
  const control = paneControl()
  await assertDesktopPanes(control, {
    appSelector: 'app',
    testId,
    privateInput: 'private-input',
    draft: 'Unsent private draft',
  })
  for (const pane of ['tasks', 'timeline', 'discussion'])
    assert.ok(
      control.calls.some(call => call.selector === testId(`collaboration-exp-pane-header-${pane}`))
    )
  assert.deepEqual(
    control.calls
      .filter(call => ['press', 'doubleClick', 'dragStart', 'dragEnd'].includes(call.action))
      .map(call => [call.action, call.options?.key]),
    [
      ['doubleClick', undefined],
      ['press', 'ArrowRight'],
      ['doubleClick', undefined],
      ['dragStart', undefined],
      ['press', 'Escape'],
      ['dragEnd', undefined],
    ]
  )
  for (const change of [
    { headers: 2 },
    { headers: 4 },
    { missingBoundary: true },
    { draft: 'Lost draft' },
  ])
    await assert.rejects(() =>
      assertDesktopPanes(paneControl(change), {
        appSelector: 'app',
        testId,
        privateInput: 'private-input',
        draft: 'Unsent private draft',
      })
    )
})

test('desktop verification rejects a broken reset even after establishing its default baseline', async () => {
  await assert.rejects(
    () =>
      assertDesktopPanes(paneControl({ resetDisabled: true }), {
        appSelector: 'app',
        testId,
        privateInput: 'private-input',
        draft: 'Unsent private draft',
      }),
    /Double-click must restore the current default widths/
  )
})

function planControl(change = {}) {
  const calls = []
  let scrolled = false
  const state = {
    ...box,
    testId: 'cloud-todo-card-status-running-issue',
    text: '进行中',
    height: 20,
  }
  const sampled = { ...box, reducedMotion: true, animations: change.liveAnimation ? [{}] : [] }
  return {
    calls,
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      assert.ok(
        !selector.includes('assistant'),
        'Project plans must verify their own real Issue states'
      )
      if (action === 'scrollIntoView') scrolled = true
      if (
        action === 'waitFor' &&
        options?.visible &&
        ((change.offscreen && !scrolled) || change.obscured)
      )
        throw new Error('The canonical Issue status remains outside the visible board viewport')
      if (action === 'getElementMetrics')
        return JSON.stringify(change.absent ? [] : [{ ...state, ...(change.state ?? {}) }])
      if (action === 'getComputedStyleValue')
        return options.value === 'animation-name' ? (change.animation ?? 'none') : '0s'
      if (action === 'getElementMetricsSample')
        return JSON.stringify({
          done: true,
          frames: [
            { ...box, connected: true, elements: [sampled] },
            { ...box, connected: true, elements: [sampled] },
          ],
        })
      return ''
    },
  }
}

test('project-plan motion verifies canonical status text, visible geometry and actual sampled animations', async () => {
  const control = planControl()
  await assertReducedPlanMotion(control, 'project-plan')
  assert.ok(
    control.calls.some(
      call =>
        call.action === 'startElementMetricsSampling' &&
        call.options.target === '[data-testid^="cloud-todo-card-status-"]'
    )
  )
  for (const change of [
    { absent: true },
    { state: { text: '' } },
    { state: { width: 0 } },
    { animation: 'spin' },
    { liveAnimation: true },
  ])
    await assert.rejects(() => assertReducedPlanMotion(planControl(change), 'project-plan'))
})

test('project-plan motion scrolls an offscreen Kanban status into view and still rejects an obscured target', async () => {
  const control = planControl({ offscreen: true })
  await assertReducedPlanMotion(control, 'project-plan')
  const selector = 'project-plan [data-testid^="cloud-todo-card-status-"]'
  assert.deepEqual(control.calls.slice(0, 3), [
    { action: 'waitFor', selector, options: undefined },
    { action: 'scrollIntoView', selector, options: undefined },
    { action: 'waitFor', selector, options: { visible: true } },
  ])
  await assert.rejects(
    () => assertReducedPlanMotion(planControl({ offscreen: true, obscured: true }), 'project-plan'),
    /remains outside the visible board viewport/
  )
})
