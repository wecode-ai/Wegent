// @vitest-environment node

import { expect, test, vi } from 'vitest'

import { createBarrier } from '../test/async-barrier'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-profile-with-review.scenario.mjs'

vi.mock('../../e2e/desktop/scenarios/stand-in-profile.scenario.mjs', () => ({
  createDesktopScenario: () => ({}),
}))
vi.mock('../../e2e/desktop/modules/preferences-automation-flows.mjs', () => ({
  ensureExperimentalFeaturesEnabled: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/layout-metrics.mjs', () => ({
  waitForElementWidth: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async () => ({ state: { completed: false } })),
}))

test.each(['ready', 'loading'])('waits for reopened review time input: %s', async state => {
  const waiting = createBarrier()
  const loaded = createBarrier()
  if (state === 'ready') loaded.release()
  const reachedCompletion = new Error('Review time filled')
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'getValue') return '09:00'
    if (action === 'getElementMetrics') return '[{"scrollWidth":760,"clientWidth":760}]'
    if (action === 'waitFor' && selector === '[data-testid="stand-in-onboarding-time"]:enabled') {
      waiting.release()
      await loaded.promise
    }
    if (
      action === 'clickWhenEnabled' &&
      selector === '[data-testid="stand-in-onboarding-complete"]'
    )
      throw reachedCompletion
  })
  const scenario = createDesktopScenario({ captureScreenshot: vi.fn(), uiTimeoutMs: 1000 })
  const verification = scenario.verify({ command }).catch((error: unknown) => error)
  try {
    expect(await Promise.race([waiting.promise.then(() => 'waiting'), verification])).toBe(
      'waiting'
    )
    if (state === 'loading')
      expect(command).not.toHaveBeenCalledWith('fill', '[data-testid="stand-in-onboarding-time"]', {
        value: '10:30',
      })
  } finally {
    loaded.release()
  }
  expect(await verification).toBe(reachedCompletion)
  expect(command).toHaveBeenCalledWith('fill', '[data-testid="stand-in-onboarding-time"]', {
    value: '10:30',
  })
  expect(command.mock.calls.filter(([action]) => action === 'waitFor').at(-1)).toEqual([
    'waitFor',
    '[data-testid="stand-in-onboarding-time"]:enabled',
    { timeoutMs: 1000 },
  ])
})
