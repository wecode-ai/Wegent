import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  assertEmptyManifestRecovery,
  emptyManifestRelaunchScript,
} from '../e2e/desktop/modules/empty-capability-manifest-upgrade.mjs'

test('the driver only seeds the manifest after activation and source executor shutdown', async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'manifest-upgrade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const capabilities = path.join(root, 'capabilities')
  const current = path.join(capabilities, 'manifest-v2.json')
  const legacy = path.join(capabilities, 'manifest.json')
  fs.mkdirSync(capabilities)
  fs.writeFileSync(current, '{"version":2}')
  fs.mkdirSync(path.join(root, 'slots', 'target'), { recursive: true })
  fs.writeFileSync(path.join(root, 'slots', 'target', 'release.json'), '{"version":"2.0.0"}')
  fs.mkdirSync(path.join(root, 'snapshots', 'checkpoint'), { recursive: true })
  fs.writeFileSync(path.join(root, 'snapshots', 'checkpoint', 'snapshot.json'), '{}')
  fs.writeFileSync(
    path.join(root, 'activation.json'),
    JSON.stringify({ from: 'source', to: 'target', snapshot: 'checkpoint' })
  )
  fs.writeFileSync(path.join(root, 'active'), 'source')

  let launches = 0
  let executorStopped = false
  const app = { relaunch: () => ++launches }
  const process = {
    getBuiltinModule: name =>
      ({
        module: { createRequire: () => () => ({ app }) },
        'node:assert/strict': assert,
        'node:fs': fs,
        'node:path': path,
      })[name],
    kill(pid, signal) {
      assert.equal(pid, 42)
      assert.equal(signal, 0)
      if (executorStopped) throw Object.assign(new Error('Process exited'), { code: 'ESRCH' })
    },
  }
  const arm = () =>
    runInNewContext(
      emptyManifestRelaunchScript({ root, capabilities, targetVersion: '2.0.0', executorPid: 42 }),
      { process }
    )

  arm()
  assert.throws(() => app.relaunch(), /after the real update selects its target/)
  fs.writeFileSync(path.join(root, 'active'), 'target')
  arm()
  assert.throws(() => app.relaunch(), /source executor must stop/)
  assert.equal(launches, 0)
  assert.deepEqual(fs.readdirSync(capabilities), ['manifest-v2.json'])

  executorStopped = true
  arm()
  app.relaunch()
  assert.equal(launches, 1)
  assert.equal(fs.statSync(legacy).size, 0)
  assert.equal(fs.existsSync(current), false)

  const backup = 'manifest.json.empty-recovered'
  fs.mkdirSync(path.join(capabilities, backup))
  fs.renameSync(legacy, path.join(capabilities, backup, 'manifest.json'))
  fs.writeFileSync(current, '{"version":2,"skills":{},"plugins":{},"mcps":{}}')
  const recovery = await assertEmptyManifestRecovery(capabilities)
  assert.equal(recovery.backup, backup)
  fs.mkdirSync(path.join(capabilities, 'manifest.json.empty-duplicate'))
  await assert.rejects(assertEmptyManifestRecovery(capabilities), /one new backup/)
})
