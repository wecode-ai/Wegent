// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-xvfb.sh')
const fixtureTimeoutMs = 10_000

function displayFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wegent-xvfb-logging-'))
  writeFileSync(join(directory, 'mcookie'), '#!/bin/sh\nprintf synthetic-checkpoint-cookie', {
    mode: 0o755,
  })
  writeFileSync(join(directory, 'xauth'), '#!/bin/sh\ntest -f "$2"', { mode: 0o755 })
  writeFileSync(
    join(directory, 'Xvfb'),
    `#!/bin/sh
set -eu
printf '%s|' "$@" > "$XVFB_TEST_DIR/arguments"
printf '%s' "$$" > "$XVFB_TEST_DIR/server-pid"
display=199
while [ "$#" -gt 0 ]; do
  case "$1" in
    :*) display=\${1#:} ;;
    -auth) shift; auth_file=$1 ;;
  esac
  shift
done
log_file="$(dirname "$auth_file")/Xvfb.log"
printf '%s' "$log_file" > "$XVFB_TEST_DIR/log-path"
printf '%s' "$auth_file" > "$XVFB_TEST_DIR/auth-path"
printf '%s\\n' 'Xvfb fixture diagnostic' >&2
if [ "\${XVFB_TEST_REMOVE_LOG:-}" = 1 ]; then rm -f "$log_file"; fi
if [ "\${XVFB_TEST_FAIL_START:-}" = 1 ]; then exit 23; fi
# Publish readiness immediately, without sending a transient parent signal.
printf '%s\\n' "$display" >&3
exec sleep 60
`,
    { mode: 0o755 }
  )
  return directory
}

function launch(directory, command, environment = {}) {
  return spawnSync('sh', [launcher, ...command], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      XVFB_TEST_DIR: directory,
      WEWORK_E2E_XVFB_SERVER_NUM: '',
      WEWORK_E2E_XVFB_SCREEN: '',
      ...environment,
    },
    encoding: 'utf8',
    timeout: fixtureTimeoutMs,
  })
}

it.each([
  { exitCode: 0 },
  { exitCode: 37 },
  { exitCode: 0, serverNum: '140' },
  { exitCode: 37, serverNum: '141' },
  { exitCode: 37, removeLog: true },
  { exitCode: 127, missingCommand: true },
  { exitCode: 0, screen: '1280x900x24' },
])(
  'preserves readiness, diagnostics, cleanup and exit status for %j',
  ({ exitCode, serverNum, removeLog, missingCommand, screen }) => {
    const directory = displayFixture()
    try {
      const command = missingCommand
        ? ['missing-wegent-test-command']
        : ['sh', '-c', `printf 'launcher stderr' >&2; exit ${exitCode}`]
      const result = launch(directory, command, {
        WEWORK_E2E_XVFB_SERVER_NUM: serverNum ?? '',
        WEWORK_E2E_XVFB_SCREEN: screen ?? '',
        XVFB_TEST_REMOVE_LOG: removeLog ? '1' : '0',
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(exitCode)
      if (!removeLog) expect(result.stderr).toContain('Xvfb fixture diagnostic')
      if (!missingCommand) expect(result.stderr).toContain('launcher stderr')
      expect(existsSync(readFileSync(join(directory, 'log-path'), 'utf8'))).toBe(false)
      expect(existsSync(readFileSync(join(directory, 'auth-path'), 'utf8'))).toBe(false)
      const pid = Number(readFileSync(join(directory, 'server-pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      const args = readFileSync(join(directory, 'arguments'), 'utf8').split('|')
      expect(args).toContain('-noreset')
      expect(args).toContain('-displayfd')
      expect(args).toContain('-auth')
      expect(args).not.toContain('-ac')
      expect(args).toContain(screen ?? '1280x720x24')
      if (serverNum) expect(args).toContain(`:${serverNum}`)
      else expect(args.some(argument => argument.startsWith(':'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
  fixtureTimeoutMs + 5_000
)

it('does not start the checkpoint when the display exits before readiness', () => {
  const directory = displayFixture()
  try {
    const marker = join(directory, 'checkpoint-started')
    const result = launch(directory, ['touch', marker], { XVFB_TEST_FAIL_START: '1' })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(23)
    expect(result.stderr).toContain('Xvfb fixture diagnostic')
    expect(result.stderr).toContain('Xvfb exited before publishing its display')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(readFileSync(join(directory, 'auth-path'), 'utf8'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['1280x900', '0x900x24', '1280x-1x24', '1280x900x8', '1280x900x24 -ac'])(
  'rejects invalid screen %j before launching Xvfb',
  screen => {
    const directory = displayFixture()
    try {
      const result = launch(directory, ['true'], { WEWORK_E2E_XVFB_SCREEN: screen })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('WEWORK_E2E_XVFB_SCREEN must be')
      expect(existsSync(join(directory, 'server-pid'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
