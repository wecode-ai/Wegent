import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-openbox.sh')
const runningWindowManager = `#!/bin/sh
echo $$ > "$OPENBOX_TEST_DIR/pid"
echo ready > "$OPENBOX_TEST_DIR/window-manager-ready"
exec /bin/sleep 1000
`

function runFixture(openbox, xprop, { instantSleep = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wegent-openbox-readiness-'))
  try {
    writeFileSync(join(directory, 'openbox'), openbox, { mode: 0o755 })
    writeFileSync(join(directory, 'xprop'), xprop, { mode: 0o755 })
    if (instantSleep) {
      writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    const result = spawnSync(
      'sh',
      [
        launcher,
        'sh',
        '-c',
        'echo started > "$OPENBOX_TEST_DIR/application"; test "$(cat "$OPENBOX_TEST_DIR/queries")" -ge 2',
      ],
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
    return {
      ...result,
      applicationStarted: existsSync(join(directory, 'application')),
      openboxStarted: existsSync(join(directory, 'pid')),
      queries: existsSync(join(directory, 'queries'))
        ? Number(readFileSync(join(directory, 'queries'), 'utf8'))
        : 0,
    }
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

it('starts the window manager only after the X server accepts a root query', () => {
  const result = runFixture(
    `#!/bin/sh
echo $$ > "$OPENBOX_TEST_DIR/pid"
if [ ! -f "$OPENBOX_TEST_DIR/x-server-ready" ]; then
  echo 'Openbox launched before the X server was ready' >&2
  exit 1
fi
echo ready > "$OPENBOX_TEST_DIR/window-manager-ready"
exec /bin/sleep 1000
`,
    `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/queries"
if [ "$#" -eq 1 ]; then
  if [ "$queries" -lt 3 ]; then exit 1; fi
  echo ready > "$OPENBOX_TEST_DIR/x-server-ready"
  exit 0
fi
if [ ! -f "$OPENBOX_TEST_DIR/window-manager-ready" ]; then exit 1; fi
echo '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234'
`
  )
  expect(result.status, result.stderr).toBe(0)
  expect(result.applicationStarted).toBe(true)
  expect(result.openboxStarted).toBe(true)
  expect(result.stderr).not.toContain('Openbox launched before the X server was ready')
})

it('never starts the window manager or application when the X server remains unavailable', () => {
  const result = runFixture(
    runningWindowManager,
    `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/queries"); fi
echo "$((queries + 1))" > "$OPENBOX_TEST_DIR/queries"
exit 1
`,
    { instantSleep: true }
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('The isolated Xvfb display did not accept an X root query')
  expect(result.queries).toBe(100)
  expect(result.openboxStarted).toBe(false)
  expect(result.applicationStarted).toBe(false)
})

it('shares the existing query budget between X server and window-manager readiness', () => {
  const result = runFixture(
    runningWindowManager,
    `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/queries"
if [ "$#" -eq 1 ]; then
  if [ "$queries" -ge 40 ]; then exit 0; fi
else
  while [ ! -f "$OPENBOX_TEST_DIR/window-manager-ready" ]; do /bin/sleep 0.001; done
fi
exit 1
`,
    { instantSleep: true }
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Openbox did not register with the isolated Xvfb display')
  expect(result.queries).toBe(100)
  expect(result.openboxStarted).toBe(true)
  expect(result.applicationStarted).toBe(false)
})
