import { expect, test } from 'vitest'

import { resolveElectronLaunchArguments } from '../e2e/desktop/modules/electron-launch-arguments.mjs'

test('keeps normal Electron launches unchanged', () => {
  expect(
    resolveElectronLaunchArguments({
      platform: 'darwin',
      getuid: () => 0,
      isolatedXvfb: 'true',
    })
  ).toEqual([])
  expect(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 1000,
      isolatedXvfb: 'true',
    })
  ).toEqual([])
})

test('runs the GPU service in-process for isolated root Electron E2E', () => {
  expect(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 0,
      isolatedXvfb: 'true',
    })
  ).toEqual(['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-dev-shm-usage'])
})

test('rejects disabling the sandbox outside isolated Xvfb', () => {
  expect(() =>
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 0,
      isolatedXvfb: undefined,
    })
  ).toThrow(/only inside isolated Xvfb/)
})
