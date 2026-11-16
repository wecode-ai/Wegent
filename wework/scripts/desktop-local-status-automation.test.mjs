// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  DESKTOP_CHECKPOINT_CI_HOSTS,
  expandDesktopCheckpoints,
} from '../e2e/desktop/checkpoints.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/collaboration-local-status-automation.scenario.mjs'

test('local status automation retains standalone selection within its existing Agent CI lifecycle', () => {
  assert.deepEqual(expandDesktopCheckpoints(['collaboration-local-status-automation']), [
    'collaboration-local-status-automation',
  ])
  assert.equal(
    DESKTOP_CHECKPOINT_CI_HOSTS.get('collaboration-local-status-automation'),
    'collaboration-local-agent-dispatch'
  )
})

test('local status automation initializes both standalone and shared host lifecycles', async () => {
  for (const checkpoint of [
    'collaboration-local-status-automation',
    'collaboration-local-agent-dispatch',
  ]) {
    const scenario = await createDesktopScenario({ checkpoint, uiTimeoutMs: 10000 })
    assert.equal(scenario.requiresCloudEnvironment, true)
    assert.equal(typeof scenario.prepareCloud, 'function')
    assert.equal(typeof scenario.verify, 'function')
    assert.equal(
      await scenario.handleHttp({ method: 'GET' }, null, new URL('http://localhost/health')),
      false
    )
  }
})
