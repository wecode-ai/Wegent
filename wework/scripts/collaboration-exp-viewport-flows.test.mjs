import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDesktopPanes } from '../e2e/desktop/modules/collaboration-exp-pane-verification.mjs'
import { assertReducedPlanMotion } from '../e2e/desktop/modules/collaboration-exp-state-motion.mjs'
import { verifyCollaborationExpViewports } from '../e2e/desktop/modules/collaboration-exp-viewport-flows.mjs'

const testId = id => `app [data-testid="${id}"]`
const box = { left: 0, top: 0, width: 300, height: 60 }

function paneControl(change = {}) {
  const calls = []
  let widths = [600, 480]
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
      if (action === 'press') widths = options.key === 'ArrowRight' ? [616, 464] : [600, 480]
      if (action === 'doubleClick') widths = [600, 480]
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

function planControl(change = {}) {
  const calls = []
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
