import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeCloudCredentialSnapshot } from '../../e2e/desktop/modules/native-cloud-credential-snapshot.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-native-credential-fixture-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  return {
    active: join(root, 'cloud-credentials.json'),
    snapshot: nativeCloudCredentialSnapshot(root, randomUUID()),
  }
}

test('restores a pre-existing profile credential after the native check', async t => {
  const { active, snapshot } = await fixture(t)
  await writeFile(active, 'original-fixture-credential')
  await snapshot.capture()
  await writeFile(active, 'temporary-fixture-credential')
  await snapshot.restore()
  assert.equal(await readFile(active, 'utf8'), 'original-fixture-credential')
})

test('removes only the newly created credential when the profile started empty', async t => {
  const { active, snapshot } = await fixture(t)
  await snapshot.capture()
  await writeFile(active, 'temporary-fixture-credential')
  await snapshot.restore()
  await assert.rejects(readFile(active), { code: 'ENOENT' })
})

test('cleanup before capture leaves the active profile untouched', async t => {
  const { active, snapshot } = await fixture(t)
  await writeFile(active, 'original-fixture-credential')
  await snapshot.restore()
  assert.equal(await readFile(active, 'utf8'), 'original-fixture-credential')
})

test('a duplicate capture cannot replace the saved credential', async t => {
  const { active, snapshot } = await fixture(t)
  await writeFile(active, 'original-fixture-credential')
  await snapshot.capture()
  await writeFile(active, 'temporary-fixture-credential')
  await assert.rejects(snapshot.capture(), { code: 'EEXIST' })
  await snapshot.restore()
  assert.equal(await readFile(active, 'utf8'), 'original-fixture-credential')
})
