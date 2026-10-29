import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-openbox.sh')

const runningOpenbox = `#!/bin/sh
echo $$ > "$OPENBOX_TEST_DIR/pid"
touch "$OPENBOX_TEST_DIR/openbox-started"
exec node -e 'setInterval(() => {}, 1000)'
`

const windowManagerProperties = `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/queries"
if [ "$queries" -lt 2 ] || [ ! -f "$OPENBOX_TEST_DIR/openbox-started" ]; then
  echo '_NET_SUPPORTING_WM_CHECK: no such atom on any window.'
else
  echo '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234'
fi
`

function runFixture(openbox, xprop, display = '#!/bin/sh\nexit 0\n') {
  const directory = mkdtempSync(join(tmpdir(), 'wegent-openbox-readiness-'))
  try {
    writeFileSync(join(directory, 'openbox'), openbox, { mode: 0o755 })
    writeFileSync(join(directory, 'xprop-window-manager'), xprop, { mode: 0o755 })
    writeFileSync(join(directory, 'xprop-display'), display, { mode: 0o755 })
    writeFileSync(
      join(directory, 'xprop'),
      `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = '-root' ]; then
  exec "$OPENBOX_TEST_DIR/xprop-display"
fi
exec "$OPENBOX_TEST_DIR/xprop-window-manager" "$@"
`,
      { mode: 0o755 }
    )
    writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const result = spawnSync(
      'sh',
      [
        launcher,
        'sh',
        '-c',
        'touch "$OPENBOX_TEST_DIR/application-launched"; test "$(cat "$OPENBOX_TEST_DIR/queries")" -ge 2',
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
    const displayQueries = join(directory, 'display-queries')
    return {
      ...result,
      openboxStarted: existsSync(join(directory, 'openbox-started')),
      applicationLaunched: existsSync(join(directory, 'application-launched')),
      displayQueries: existsSync(displayQueries) ? Number(readFileSync(displayQueries, 'utf8')) : 0,
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
  const result = runFixture(runningOpenbox, windowManagerProperties)
  expect(result.status, result.stderr).toBe(0)
  expect(result.applicationLaunched).toBe(true)
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
  expect(result.applicationLaunched).toBe(false)
})

it('waits for the X connection before starting Openbox', () => {
  const result = runFixture(
    runningOpenbox,
    windowManagerProperties,
    `#!/bin/sh
if [ -f "$OPENBOX_TEST_DIR/openbox-started" ]; then
  echo 'Openbox started before the X connection was ready' >&2
  exit 1
fi
queries=0
if [ -f "$OPENBOX_TEST_DIR/display-queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/display-queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/display-queries"
if [ "$queries" -lt 3 ]; then
  echo "X connection unavailable probe=$queries" >&2
  exit 1
fi
`
  )
  expect(result.status, result.stderr).toBe(0)
  expect(result.displayQueries).toBe(3)
  expect(result.openboxStarted).toBe(true)
  expect(result.applicationLaunched).toBe(true)
})

it('rejects an unavailable X display before launching Openbox or the application', () => {
  const result = runFixture(
    runningOpenbox,
    windowManagerProperties,
    `#!/bin/sh
queries=0
if [ -f "$OPENBOX_TEST_DIR/display-queries" ]; then queries=$(cat "$OPENBOX_TEST_DIR/display-queries"); fi
queries=$((queries + 1))
echo "$queries" > "$OPENBOX_TEST_DIR/display-queries"
echo "X connection unavailable probe=$queries" >&2
exit 1
`
  )
  expect(result.status).toBe(1)
  expect(result.displayQueries).toBe(100)
  expect(result.openboxStarted).toBe(false)
  expect(result.applicationLaunched).toBe(false)
  expect(result.stderr).toContain('display=:1234')
  expect(result.stderr).toContain('Xvfb display did not become reachable')
  expect(result.stderr).toContain('X connection unavailable probe=100')
})
