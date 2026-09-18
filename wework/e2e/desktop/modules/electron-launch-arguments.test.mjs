import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

test('appends scenario-specific Electron switches', () => {
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'darwin',
      extraArguments: ['--proxy-server=http://127.0.0.1:7890'],
    }),
    ['--proxy-server=http://127.0.0.1:7890']
  )
})

test('preserves root Linux sandbox switches before scenario arguments', () => {
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 0,
      isolatedXvfb: 'true',
      extraArguments: ['--proxy-server=socks5://127.0.0.1:1080'],
    }),
    [
      '--no-sandbox',
      '--disable-gpu',
      '--in-process-gpu',
      '--disable-dev-shm-usage',
      '--proxy-server=socks5://127.0.0.1:1080',
    ]
  )
})

test('rejects positional scenario arguments', () => {
  assert.throws(
    () =>
      resolveElectronLaunchArguments({
        platform: 'darwin',
        extraArguments: ['/tmp/unexpected'],
      }),
    /Invalid Electron E2E launch argument/
  )
})
