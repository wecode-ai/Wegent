import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-xvfb.sh')

it.each([
  { exitCode: 0 },
  { exitCode: 37 },
  { exitCode: 0, serverNum: '140' },
  { exitCode: 37, serverNum: '141' },
  { exitCode: 37, removeLog: true },
  { exitCode: 127, missingCommand: true },
])(
  'preserves diagnostics, cleanup and exit status for %j',
  ({ exitCode, serverNum, removeLog, missingCommand }) => {
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
          XVFB_TEST_REMOVE_LOG: removeLog ? '1' : '0',
        },
        encoding: 'utf8',
        timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(exitCode)
      if (!removeLog) expect(result.stderr).toContain('Xvfb fixture diagnostic')
      if (!missingCommand) expect(result.stderr).toContain('launcher stderr')
      expect(existsSync(readFileSync(join(directory, 'log-path'), 'utf8'))).toBe(false)
      const args = readFileSync(join(directory, 'arguments'), 'utf8').split('|')
      expect(args).toContain('--server-args=-noreset -screen 0 1280x720x24')
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
  }
)
