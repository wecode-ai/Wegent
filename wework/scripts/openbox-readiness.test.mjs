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
