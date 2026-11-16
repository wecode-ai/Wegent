import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { createLocalSnapshotFixture } from '../e2e/desktop/modules/local-snapshot-auth-fixture.mjs'

const run = promisify(execFile)

test('logout succeeds after removing the source; health alone requests login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-contract-'))
  try {
    await mkdir(join(root, 'scripts'))
    const home = join(root, 'home')
    await createLocalSnapshotFixture(root, home)
    const action = async value => {
      const result = await run(
        'uv',
        ['run', '--no-project', 'python', join(root, 'scripts/snapshot-auth.py'), value],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            PYTHONPATH: resolve('..', 'sdk/plugin-auth'),
          },
        }
      )
      return JSON.parse(result.stdout)
    }
    expect(await action('local-health')).toEqual({ status: 'ok' })
    expect(await action('local-logout')).toEqual({ status: 'ok' })
    expect(await action('local-logout')).toEqual({ status: 'ok' })
    expect(await action('local-health')).toEqual({ status: 'need_login' })
    expect(await action('local-login')).toEqual({ status: 'ok' })
    expect(await action('local-health')).toEqual({ status: 'ok' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
