import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
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
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
    WEWORK_E2E_MODEL_SERVER_URL: 'http://127.0.0.1:1235',
  })
})

test('preserves Windows environment spelling without losing its executable search path', () => {
  const environment = upgradeUserEnvironment(
    {
      Path: 'C:\\Windows;C:\\Tools',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\runner',
    },
    'C:\\isolated'
  )
  assert.equal(environment.Path, 'C:\\Windows;C:\\Tools')
  assert.equal(environment.SystemRoot, 'C:\\Windows')
  assert.equal(environment.USERPROFILE, 'C:\\Users\\runner')
  assert.equal(environment.HOME, 'C:\\isolated')
})

if (process.platform === 'win32') {
  test('isolating HOME preserves the real Windows Shell AppData directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wework-native-profile-'))
    try {
      const environment = upgradeUserEnvironment(process.env, home)
      const cases = [
        { name: 'native', environment: process.env, timeout: 30_000 },
        { name: 'isolated', environment, timeout: 10_000 },
      ]
      const observations = await Promise.all(cases.map(observeWindowsAppData))
      if (observations.some(result => result.error)) {
        console.error(JSON.stringify(observations))
      }
      for (const result of observations) assert.ifError(result.error)
      const [native, isolated] = observations
      assert.ok(isolated.stdout.trim(), 'Windows could not resolve the application-data directory')
      assert.equal(await realpath(isolated.stdout.trim()), await realpath(native.stdout.trim()))
      assert.equal(environment.HOME, home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}

async function observeWindowsAppData({ name, environment, timeout }) {
  const started = Date.now()
  try {
    const result = await promisify(execFile)(
      join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          '[Console]::Error.WriteLine("probe-entered")',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
          '[Console]::Error.WriteLine("encoding-ready")',
          '[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)',
          '[Console]::Error.WriteLine("query-finished")',
          'if ([string]::IsNullOrWhiteSpace([System.Diagnostics.Process]::GetProcessById($PID).MainModule.FileName)) { throw "Native process path is unavailable" }',
          '[Console]::Error.WriteLine("process-query-finished")',
        ].join('; '),
      ],
      { env: environment, timeout, maxBuffer: 4096, windowsHide: true }
    )
    return { name, elapsedMs: Date.now() - started, ...result }
  } catch (error) {
    return {
      name,
      elapsedMs: Date.now() - started,
      error,
      code: error.code,
      signal: error.signal,
      killed: error.killed,
      stdout: error.stdout,
      stderr: error.stderr,
    }
  }
}
