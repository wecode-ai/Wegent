import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-openbox.sh')

function runFixture(openbox, xprop) {
  const directory = mkdtempSync(join(tmpdir(), 'wegent-openbox-readiness-'))
  try {
    writeFileSync(join(directory, 'openbox'), openbox, { mode: 0o755 })
    writeFileSync(join(directory, 'xprop'), xprop, { mode: 0o755 })
    const result = spawnSync(
      'sh',
      [launcher, 'sh', '-c', 'test "$(cat "$OPENBOX_TEST_DIR/queries")" -ge 2'],
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
    return result
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
    `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.OPENBOX_TEST_DIR + '/pid', String(process.pid))
setInterval(() => {}, 1000)
`,
    `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/queries"
if [ "$queries" -lt 2 ]; then
  echo '_NET_SUPPORTING_WM_CHECK: no such atom on any window.'
else
  echo '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234'
fi
`
  )
  expect(result.status, result.stderr).toBe(0)
})

it('fails before launching the application when the window manager exits', () => {
  const result = runFixture(
    `#!/bin/sh
echo 'window manager fixture failed' >&2
exit 1
`,
    `#!/bin/sh
echo 2 > "$OPENBOX_TEST_DIR/queries"
echo '_NET_SUPPORTING_WM_CHECK: no such atom on any window.'
`
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('window manager fixture failed')
  expect(result.stderr).toContain('Openbox exited before registering')
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
