import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ISOLATED_XVFB_SERVER_ARGUMENTS } from '../e2e/desktop/checkpoint-environment.mjs'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-openbox.sh')
const runningWindowManager = `#!/bin/sh
echo $$ > "$OPENBOX_TEST_DIR/pid"
echo ready > "$OPENBOX_TEST_DIR/window-manager-ready"
exec /bin/sleep 1000
`

function runFixture(openbox, xprop) {
  const directory = mkdtempSync(join(tmpdir(), 'wegent-openbox-readiness-'))
  try {
    writeFileSync(join(directory, 'openbox'), openbox, { mode: 0o755 })
    writeFileSync(join(directory, 'xprop'), xprop, { mode: 0o755 })
    const result = spawnSync(
      'sh',
      [launcher, 'sh', '-c', 'echo started > "$OPENBOX_TEST_DIR/application"'],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          DISPLAY: ':1234',
          OPENBOX_TEST_DIR: directory,
        },
        encoding: 'utf8',
        timeout: 10_000,
      }
    )
    expect(result.error).toBeUndefined()
    return { ...result, applicationStarted: existsSync(join(directory, 'application')) }
  } finally {
    try {
      process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')))
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

it('waits for a registered window id after xprop reports a missing atom', () => {
  const result = runFixture(
    runningWindowManager,
    `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/queries"
if [ "$queries" -lt 2 ] || [ ! -f "$OPENBOX_TEST_DIR/window-manager-ready" ]; then
  echo '_NET_SUPPORTING_WM_CHECK: no such atom on any window.'
else
  echo '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234'
fi
`
  )
  expect(result.status, result.stderr).toBe(0)
  expect(result.applicationStarted).toBe(true)
})

it('fails before launching the application when the window manager exits', () => {
  const result = runFixture(
    `#!/bin/sh
echo 'window manager fixture failed' >&2
exit 1
`,
    `#!/bin/sh
echo '_NET_SUPPORTING_WM_CHECK: no such atom on any window.'
`
  )
  expect(result.status).toBe(1)
  expect(result.applicationStarted).toBe(false)
  expect(result.stderr).toContain('window manager fixture failed')
  expect(result.stderr).toContain('Openbox exited before registering')
})

function readRootPropertyAfterDisconnect(serverArguments) {
  const result = spawnSync(
    'xvfb-run',
    [
      '-a',
      `--server-args=${serverArguments}`,
      process.execPath,
      '--input-type=module',
      '-e',
      `
import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
const property = '_WEWORK_E2E_DISPLAY_LIFECYCLE'
execFileSync('xprop', ['-root', '-f', property, '8s', '-set', property, 'retained'])
// A deliberate client-free interval exercises the server's reset lifecycle.
await setTimeout(1_000)
const value = execFileSync('xprop', ['-root', property], { encoding: 'utf8' })
console.log(value.includes('"retained"') ? 'retained' : 'reset')
`,
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

it.runIf(process.platform === 'linux')('keeps the real display alive between client connections', () => {
  expect(readRootPropertyAfterDisconnect(ISOLATED_XVFB_SERVER_ARGUMENTS)).toBe('retained')
})

it.runIf(process.platform === 'linux')('reproduces the root-property reset without the lifecycle fix', () => {
  const resetArguments = ISOLATED_XVFB_SERVER_ARGUMENTS.replace(' -noreset', '')
  expect(readRootPropertyAfterDisconnect(resetArguments)).toBe('reset')
})

it('starts the window manager only after the display accepts connections', () => {
  const result = runFixture(
    `#!/usr/bin/env node
const fs = require('node:fs')
const directory = process.env.OPENBOX_TEST_DIR
fs.writeFileSync(directory + '/pid', String(process.pid))
if (Number(fs.readFileSync(directory + '/queries', 'utf8')) < 3) process.exit(1)
fs.writeFileSync(directory + '/registered', '')
setInterval(() => {}, 1000)
`,
    `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/queries"
if [ "$queries" -lt 3 ]; then exit 1; fi
if [ -f "$OPENBOX_TEST_DIR/registered" ]; then
  echo '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234'
else
  echo '_NET_SUPPORTING_WM_CHECK: no such atom on any window.'
fi
`
  )
  expect(result.status, result.stderr).toBe(0)
})

it('fails without launching the window manager when the display never connects', () => {
  const result = runFixture(
    `#!/bin/sh
echo 'The window manager must not start' >&2
exit 1
`,
    `#!/bin/sh
exit 1
`
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Xvfb did not accept connections on :1234')
  expect(result.stderr).not.toContain('The window manager must not start')
}, 10_000)
