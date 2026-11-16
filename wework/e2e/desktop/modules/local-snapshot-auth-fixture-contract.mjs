import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createLocalSnapshotFixture } from './local-snapshot-auth-fixture.mjs'

const run = promisify(execFile)
const sdk = fileURLToPath(new URL('../../../../sdk/plugin-auth', import.meta.url))

/** Execute the generated script in the existing Python-capable E2E environment. */
export async function verifySnapshotFixtureContract(resultDir) {
  const root = join(resultDir, 'snapshot-script-contract')
  await mkdir(join(root, 'scripts'), { recursive: true })
  const home = join(root, 'home')
  try {
    await createLocalSnapshotFixture(root, home)
    const actions = [
      'local-health',
      'local-logout',
      'local-logout',
      'local-health',
      'local-login',
      'local-health',
    ]
    const expected = ['ok', 'ok', 'ok', 'need_login', 'ok', 'ok']
    for (const [index, action] of actions.entries()) {
      const result = await run(
        'uv',
        ['run', '--no-project', 'python', join(root, 'scripts/snapshot-auth.py'), action],
        {
          env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONPATH: sdk },
          timeout: 10_000,
        }
      )
      assert.deepEqual(JSON.parse(result.stdout), { status: expected[index] }, action)
    }
    await writeFile(
      join(resultDir, 'snapshot-fixture-contract.json'),
      JSON.stringify({ verified: true, actions, expected })
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
