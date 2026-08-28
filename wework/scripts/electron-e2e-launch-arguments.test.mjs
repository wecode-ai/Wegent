import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveElectronLaunchArguments } from '../e2e/desktop/modules/electron-launch-arguments.mjs'

test('keeps normal Electron launches unchanged', () => {
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'darwin',
      getuid: () => 0,
      isolatedXvfb: 'true',
    }),
    []
  )
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 1000,
      isolatedXvfb: 'true',
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
    }),
    ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-dev-shm-usage']
  )
})

test('rejects disabling the sandbox outside isolated Xvfb', () => {
  assert.throws(
    () =>
      resolveElectronLaunchArguments({
        platform: 'linux',
        getuid: () => 0,
        isolatedXvfb: undefined,
      }),
    /only inside isolated Xvfb/
  )
})
