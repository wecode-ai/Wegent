// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-xvfb.sh')
const fixtureTimeoutMs = 10_000

it.each([
  { exitCode: 0 },
  { exitCode: 37 },
  { exitCode: 0, serverNum: '140' },
  { exitCode: 37, serverNum: '141' },
  { exitCode: 37, removeLog: true },
  { exitCode: 127, missingCommand: true },
  { exitCode: 0, screen: '1280x900x24' },
])(
  'preserves diagnostics, cleanup and exit status for %j',
  ({ exitCode, serverNum, removeLog, missingCommand, screen }) => {
    const directory = mkdtempSync(join(tmpdir(), 'wegent-xvfb-logging-'))
    try {
      writeFileSync(
        join(directory, 'xvfb-run'),
        `#!/bin/sh
set -eu
printf '%s|' "$@" > "$XVFB_TEST_DIR/arguments"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -a|--server-num=*|--server-args=*) shift ;;
    --error-file=*) error_file=\${1#--error-file=}; shift ;;
    *) break ;;
  esac
done
test -f "$error_file"
printf '%s' "$error_file" > "$XVFB_TEST_DIR/log-path"
printf '%s\\n' 'Xvfb fixture diagnostic' >> "$error_file"
if [ "\${XVFB_TEST_REMOVE_LOG:-}" = 1 ]; then rm -f "$error_file"; fi
"$@"
`,
        { mode: 0o755 }
      )
      const command = missingCommand
        ? ['missing-wegent-test-command']
        : ['sh', '-c', `printf 'launcher stderr' >&2; exit ${exitCode}`]
      const result = spawnSync('sh', [launcher, ...command], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          XVFB_TEST_DIR: directory,
          WEWORK_E2E_XVFB_SERVER_NUM: serverNum ?? '',
          WEWORK_E2E_XVFB_SCREEN: screen ?? '',
          XVFB_TEST_REMOVE_LOG: removeLog ? '1' : '0',
        },
        encoding: 'utf8',
        timeout: fixtureTimeoutMs,
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(exitCode)
      if (!removeLog) expect(result.stderr).toContain('Xvfb fixture diagnostic')
      if (!missingCommand) expect(result.stderr).toContain('launcher stderr')
      expect(existsSync(readFileSync(join(directory, 'log-path'), 'utf8'))).toBe(false)
      const args = readFileSync(join(directory, 'arguments'), 'utf8').split('|')
      expect(args).toContain(`--server-args=-noreset -screen 0 ${screen ?? '1280x720x24'}`)
      if (serverNum) {
        expect(args).toContain(`--server-num=${serverNum}`)
        expect(args).not.toContain('-a')
      } else {
        expect(args).toContain('-a')
        expect(args.some(argument => argument.startsWith('--server-num='))).toBe(false)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
  // The outer deadline must include the synchronous child's existing timeout.
  fixtureTimeoutMs + 5_000
)

it.each(['1280x900', '0x900x24', '1280x-1x24', '1280x900x8', '1280x900x24 -ac'])(
  'rejects invalid screen %j before launching Xvfb',
  screen => {
    const directory = mkdtempSync(join(tmpdir(), 'wegent-xvfb-invalid-screen-'))
    try {
      const marker = join(directory, 'launched')
      writeFileSync(join(directory, 'xvfb-run'), `#!/bin/sh\ntouch '${marker}'\n`, {
        mode: 0o755,
      })
      const result = spawnSync('sh', [launcher, 'true'], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          WEWORK_E2E_XVFB_SCREEN: screen,
        },
        encoding: 'utf8',
        timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('WEWORK_E2E_XVFB_SCREEN must be')
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
