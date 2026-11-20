import assert from 'node:assert/strict'
import test from 'node:test'

import { checkpointScenarioEnv } from './checkpoint-scenario-env.mjs'

test('upgrade diagnostics do not relabel local regression fixtures as signed releases', () => {
  const environment = checkpointScenarioEnv(
    {
      WEWORK_E2E_APP_BIN: '/target/WeWork',
      WEWORK_E2E_EXECUTOR_BIN: '/target/executor',
      WEWORK_E2E_UPGRADE_SOURCE_APP_BIN: '/source/WeWork',
      WEWORK_E2E_UPGRADE_SOURCE_EXECUTOR_BIN: '/source/executor',
    },
    'app-update-retry'
  )

  assert.equal(environment.WEWORK_E2E_APP_BIN, '/source/WeWork')
  assert.equal(environment.WEWORK_E2E_EXECUTOR_BIN, '/source/executor')
  assert.equal(environment.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE, undefined)
})

test('upgrade diagnostics preserve an explicit signed release requirement', () => {
  const environment = checkpointScenarioEnv(
    { WEWORK_E2E_REQUIRE_RELEASE_PACKAGE: '1' },
    'app-update-retry'
  )

  assert.equal(environment.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE, '1')
})
