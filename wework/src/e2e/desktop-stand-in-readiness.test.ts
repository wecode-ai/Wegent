// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createBarrier as barrier } from '../test/async-barrier'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-action-confirmation.scenario.mjs'

test('Stand-in confirmation waits for navigation to mount before opening the owner page', async () => {
  const waiting = barrier()
  const mounted = barrier()
  const reachedOwner = new Error('Owner page is ready')
  const calls: Array<{ action: string; selector: string }> = []
  let preferencesApplied = false
  const scenario = createDesktopScenario({ workspacePath: '/fixture' })
  const verification = scenario
    .verify({
      async command(action: string, selector: string, options?: { value?: string }) {
        calls.push({ action, selector })
        if (action === 'getElementCount') {
          assert.equal(selector, '[data-testid="settings-button"]')
          return '0'
        }
        if (action === 'setAppPreferences') {
          assert.equal(selector, 'body')
          assert.ok(options?.value)
          assert.deepEqual(JSON.parse(options.value), { experimentalFeaturesEnabled: true })
          preferencesApplied = true
          return
        }
        if (selector === '[data-testid="personal-stand-in-button"]') {
          assert.equal(preferencesApplied, true, 'Navigation requires the live preference setup')
          if (action === 'click') throw new Error('Stand-in navigation is still mounting')
          assert.equal(action, 'clickWhenEnabled')
          waiting.release()
          await mounted.promise
        }
        if (selector === '[data-testid="stand-in-overview"]') throw reachedOwner
      },
    })
    .then(
      () => new Error('Expected the owner-page boundary'),
      (error: unknown) => error
    )
  try {
    assert.equal(
      await Promise.race([waiting.promise.then(() => 'waiting'), verification]),
      'waiting'
    )
    assert.deepEqual(calls.slice(0, 2), [
      { action: 'getElementCount', selector: '[data-testid="settings-button"]' },
      { action: 'setAppPreferences', selector: 'body' },
    ])
    assert.equal(
      calls.some(call => call.selector === '[data-testid="stand-in-overview"]'),
      false
    )
  } finally {
    mounted.release()
  }
  assert.equal(await verification, reachedOwner)
})
