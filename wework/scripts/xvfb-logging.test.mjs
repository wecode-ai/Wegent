import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../e2e/desktop/run-with-xvfb.sh')

it.each([0, 37])('preserves diagnostics, cleanup and command exit %i', exitCode => {
  const directory = mkdtempSync(join(tmpdir(), 'wegent-xvfb-logging-'))
  try {
    writeFileSync(
      join(directory, 'xvfb-run'),
      `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -a|--server-args=*) shift ;;
    --error-file=*) error_file=\${1#--error-file=}; shift ;;
    *) break ;;
  esac
done
test -f "$error_file"
printf '%s' "$error_file" > "$XVFB_TEST_DIR/log-path"
printf '%s\\n' 'Xvfb fixture diagnostic' >> "$error_file"
"$@"
`,
      { mode: 0o755 }
    )
    const result = spawnSync('sh', [launcher, 'sh', '-c', `exit ${exitCode}`], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        XVFB_TEST_DIR: directory,
      },
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(exitCode)
    expect(result.stderr).toContain('Xvfb fixture diagnostic')
    expect(existsSync(readFileSync(join(directory, 'log-path'), 'utf8'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
