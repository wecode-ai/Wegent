import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chromiumVerboseLoggingArguments,
  resolveElectronLaunchArguments,
} from './electron-launch-arguments.mjs'

test('appends scenario-specific Electron switches', () => {
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'darwin',
      verboseLoggingArguments: [],
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
      verboseLoggingArguments: [],
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
        verboseLoggingArguments: [],
        extraArguments: ['/tmp/unexpected'],
      }),
    /Invalid Electron E2E launch argument/
  )
})

test('resolves the Chromium verbose logging env matrix', () => {
  // Isolate the ambient variable: the resolver's default parameter reads the
  // real env when the argument is undefined, so a job-wide diagnostic setting
  // must not leak into these assertions.
  const previous = process.env.WEWORK_E2E_CHROMIUM_VERBOSE
  delete process.env.WEWORK_E2E_CHROMIUM_VERBOSE
  try {
    assert.deepEqual(chromiumVerboseLoggingArguments(undefined), [])
    assert.deepEqual(chromiumVerboseLoggingArguments(''), [])
    assert.deepEqual(chromiumVerboseLoggingArguments('false'), [])
    assert.deepEqual(chromiumVerboseLoggingArguments('0'), [])
    assert.deepEqual(chromiumVerboseLoggingArguments('true'), ['--enable-logging=stderr', '--v=1'])
    assert.deepEqual(chromiumVerboseLoggingArguments('3'), ['--enable-logging=stderr', '--v=3'])
    assert.deepEqual(chromiumVerboseLoggingArguments('1'), ['--enable-logging=stderr', '--v=1'])
    assert.throws(() => chromiumVerboseLoggingArguments('bogus'), /verbosity level/)
    assert.throws(() => chromiumVerboseLoggingArguments('10'), /verbosity level/)
    assert.throws(() => chromiumVerboseLoggingArguments('-1'), /verbosity level/)
  } finally {
    if (previous !== undefined) process.env.WEWORK_E2E_CHROMIUM_VERBOSE = previous
  }
})

test('appends Chromium verbose logging switches when a diagnostic run requests them', () => {
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 0,
      isolatedXvfb: 'true',
      verboseLoggingArguments: ['--enable-logging=stderr', '--v=1'],
    }),
    [
      '--no-sandbox',
      '--disable-gpu',
      '--in-process-gpu',
      '--disable-dev-shm-usage',
      '--enable-logging=stderr',
      '--v=1',
    ]
  )
  // Production win32 scenario arguments always include file logging; the later
  // --enable-logging=file wins under Chromium's last-wins switch semantics, so
  // verbose output lands in electron.log on Windows rather than stderr.
  assert.deepEqual(
    resolveElectronLaunchArguments({
      platform: 'win32',
      verboseLoggingArguments: ['--enable-logging=stderr', '--v=1'],
      extraArguments: ['--enable-logging=file', '--log-file=/tmp/electron.log'],
    }),
    [
      '--disable-features=TcpPortRandomizationWin',
      '--enable-logging=stderr',
      '--v=1',
      '--enable-logging=file',
      '--log-file=/tmp/electron.log',
    ]
  )
})

test('rejects malformed verbose logging argument lists', () => {
  assert.throws(
    () =>
      resolveElectronLaunchArguments({
        platform: 'darwin',
        verboseLoggingArguments: '--enable-logging=stderr',
      }),
    /verbose logging arguments must be an array/
  )
})
