import assert from 'node:assert/strict'
import { test } from 'node:test'
import { upgradeUserEnvironment } from './modules/upgrade-user-environment.mjs'

test('upgrade acceptance inherits only OS settings and the test driver/model services', () => {
  const result = upgradeUserEnvironment(
    {
      PATH: '/bin',
      HOME: '/personal',
      WEWORK_USER_DATA_DIR: '/override',
      WEWORK_UPDATE_BASE_URL: 'https://override',
      WEWORK_HARNESS_RUNTIME_ROOT: '/override',
      WEWORK_EXECUTOR_PATH: '/override',
      WEWORK_APP_IDENTIFIER: 'override',
      WEGENT_EXECUTOR_HOME: '/override',
      CODEX_HOME: '/override',
      CODEX_BINARY_PATH: '/override',
      ELECTRON_RUN_AS_NODE: '1',
      UNKNOWN_FUTURE_PRODUCT_OVERRIDE: 'override',
      WEWORK_E2E_DISABLE_COMPONENT_UPDATES: '1',
      WEWORK_E2E_BACKGROUND_WINDOW: '1',
      VITE_WEWORK_E2E: 'true',
      WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
      WEWORK_E2E_MODEL_SERVER_URL: 'http://127.0.0.1:1235',
    },
    '/isolated'
  )
  assert.deepEqual(result, {
    PATH: '/bin',
    HOME: '/isolated',
    USERPROFILE: '/isolated',
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
    WEWORK_E2E_MODEL_SERVER_URL: 'http://127.0.0.1:1235',
  })
})

test('preserves Windows environment spelling without losing its executable search path', () => {
  const environment = upgradeUserEnvironment(
    { Path: 'C:\\Windows;C:\\Tools', SystemRoot: 'C:\\Windows' },
    'C:\\isolated'
  )
  assert.equal(environment.Path, 'C:\\Windows;C:\\Tools')
  assert.equal(environment.SystemRoot, 'C:\\Windows')
})
