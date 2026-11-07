import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveElectronLaunchArguments } from '../e2e/desktop/modules/electron-launch-arguments.mjs'

// Every call passes verboseLoggingArguments explicitly so these tests stay
// isolated from a WEWORK_E2E_CHROMIUM_VERBOSE environment a diagnostic run
// may have exported job-wide.
test('keeps normal Electron launches unchanged', () => {
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'darwin',
      getuid: () => 0,
      isolatedXvfb: 'true',
      verboseLoggingArguments: [],
    }),
    []
  )
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 1000,
      isolatedXvfb: 'true',
      verboseLoggingArguments: [],
    }),
    []
  )
})

test('runs the GPU service in-process for isolated root Electron E2E', () => {
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 0,
      isolatedXvfb: 'true',
      verboseLoggingArguments: [],
    }),
    ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-dev-shm-usage']
  )
})

test('keeps scenario arguments for every platform', () => {
  const extraArguments = ['--proxy-server=http://127.0.0.1:18080']
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'win32',
      extraArguments,
      verboseLoggingArguments: [],
    }),
    ['--disable-features=TcpPortRandomizationWin', ...extraArguments]
  )
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 0,
      isolatedXvfb: 'true',
      extraArguments,
      verboseLoggingArguments: [],
    }),
    [
      '--no-sandbox',
      '--disable-gpu',
      '--in-process-gpu',
      '--disable-dev-shm-usage',
      '--proxy-server=http://127.0.0.1:18080',
    ]
  )
})

test('rejects disabling the sandbox outside isolated Xvfb', () => {
  assert.throws(
    () =>
      resolveElectronLaunchArguments({
        platform: 'linux',
        getuid: () => 0,
        isolatedXvfb: undefined,
        verboseLoggingArguments: [],
      }),
    /only inside isolated Xvfb/
  )
})

test('keeps Windows loopback traffic on the OS allocator without losing scenario features', () => {
  const extraArguments = [
    '--disable-features=FirstFeature,TcpPortRandomizationWin',
    '--proxy-server=http://127.0.0.1:18080',
    '--disable-features=SecondFeature',
  ]
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'win32',
      extraArguments,
      verboseLoggingArguments: [],
    }),
    [
      '--disable-features=TcpPortRandomizationWin,FirstFeature,SecondFeature',
      '--proxy-server=http://127.0.0.1:18080',
    ]
  )
  assert.equal(extraArguments.length, 3, 'Resolving flags mutated scenario arguments')
})
