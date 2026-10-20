import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'vitest'
import { resolveCheckpointProcess } from '../e2e/desktop/modules/checkpoint-process-command.mjs'

const scriptDir = '/isolated/wework/e2e/desktop'
const executable = '/tools/node'
const environment = { WEWORK_E2E_ISOLATED_XVFB: 'true' }

test('starts the native accessibility session inside Xvfb before the window manager and app', () => {
  const launch = resolveCheckpointProcess({
    args: ['--segment', 'native-directory-picker'],
    scriptDir,
    executable,
    environment,
    platform: 'linux',
  })

  assert.equal(launch.command, 'xvfb-run')
  assert.deepEqual(launch.args.slice(2, 8), [
    'dbus-run-session',
    '--',
    'sh',
    join(scriptDir, 'run-with-native-accessibility.sh'),
    'sh',
    join(scriptDir, 'run-with-openbox.sh'),
  ])
  assert.deepEqual(launch.args.slice(8), [
    executable,
    join(scriptDir, 'task-flow.e2e.mjs'),
    '--segment',
    'native-directory-picker',
  ])
})

test('keeps other isolated checkpoints independent of native accessibility services', () => {
  const launch = resolveCheckpointProcess({
    args: ['--segment', 'running-sidebar-state'],
    scriptDir,
    executable,
    environment,
    platform: 'linux',
  })

  assert.equal(launch.command, 'xvfb-run')
  assert.equal(launch.args.includes('dbus-run-session'), false)
  assert.deepEqual(launch.args.slice(2, 5), [
    'sh',
    join(scriptDir, 'run-with-openbox.sh'),
    executable,
  ])
})

for (const platform of ['darwin', 'win32']) {
  test(`preserves the ${platform} native process launch`, () => {
    const launch = resolveCheckpointProcess({
      args: ['--segment', 'native-directory-picker'],
      scriptDir,
      executable,
      environment,
      platform,
    })

    assert.equal(launch.command, executable)
    assert.deepEqual(launch.args, [
      join(scriptDir, 'task-flow.e2e.mjs'),
      '--segment',
      'native-directory-picker',
    ])
  })
}
