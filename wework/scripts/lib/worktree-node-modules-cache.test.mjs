import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  )
})

describe('worktree node_modules cache lock', () => {
  test('holds the publication lock while validating cache readiness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-node-modules-lock-'))
    temporaryDirectories.push(directory)
    const library = join(import.meta.dirname, 'worktree-node-modules-cache.sh')

    const { stdout } = await execFileAsync('bash', [
      '-c',
      `
        set -euo pipefail
        source "$1"
        cache_entry="$2/cache"
        entered="$2/entered"

        wegent_wework_cache_entry_ready() {
          touch "$entered"
          sleep 0.3
          return 0
        }

        wegent_validate_wework_cache_entry_under_lock "$cache_entry" fingerprint &
        reader_pid=$!
        while [ ! -f "$entered" ]; do sleep 0.01; done

        if mkdir "\${cache_entry}.lock" 2>/dev/null; then
          echo writer-acquired-during-validation
          rmdir "\${cache_entry}.lock"
          exit 1
        fi

        wait "$reader_pid"
        mkdir "\${cache_entry}.lock"
        rmdir "\${cache_entry}.lock"
        echo atomic
      `,
      'bash',
      library,
      directory,
    ])

    expect(stdout.trim()).toBe('atomic')
  })
})
