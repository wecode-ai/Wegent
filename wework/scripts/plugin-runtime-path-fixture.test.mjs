import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createBusinessPackage,
  isolatedPath,
  pluginEntry,
  readCapabilityManifest,
  reformatRuntimeManifests,
  relocateInstalledHome,
  relocatedPath,
  rewriteRuntimeManifests,
} from '../e2e/desktop/modules/plugin-runtime-path-fixture.mjs'

async function manifestFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-manifest-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime')
  await createBusinessPackage(runtime, 'real-plugin', '1.0.0')
  await mkdir(join(runtime, '.claude-plugin'))
  const metadata = JSON.parse(await readFile(join(runtime, '.codex-plugin/plugin.json')))
  metadata.author = { name: 'Fixture', url: 'https://example.test' }
  for (const name of ['.codex-plugin', '.claude-plugin']) {
    await writeFile(join(runtime, name, 'plugin.json'), JSON.stringify(metadata))
  }
  return { root, runtime, entry: { runtime: { codex_link: runtime } } }
}

test('formatting fixture changes both root manifest bytes without changing JSON or scripts', async t => {
  const { root, runtime, entry } = await manifestFixture(t)
  const script = await readFile(join(runtime, 'scripts/business.sh'))
  const changes = await reformatRuntimeManifests(root, entry)
  assert.equal(changes.length, 2)
  for (const change of changes) {
    const original = JSON.parse(change.original)
    const updated = JSON.parse(change.updated)
    assert.notDeepEqual(change.original, change.updated)
    assert.deepEqual(original, updated)
    assert.notDeepEqual(Object.keys(original.author), Object.keys(updated.author))
    assert.deepEqual(updated.keywords, ['runtime-recovery', 'business-command'])
    assert.deepEqual(await readFile(change.path), change.updated)
  }
  assert.deepEqual(await readFile(join(runtime, 'scripts/business.sh')), script)
})

test('semantic fixtures change a field and array order without changing plugin identity', async t => {
  const { root, entry } = await manifestFixture(t)
  const changes = await rewriteRuntimeManifests(root, entry, (metadata, path) => {
    if (path === '.codex-plugin/plugin.json') metadata.description += ' user edit'
    else metadata.keywords.reverse()
    return metadata
  })
  for (const change of changes) {
    const original = JSON.parse(change.original)
    const updated = JSON.parse(change.updated)
    assert.equal(updated.name, original.name)
    assert.equal(updated.version, original.version)
    assert.notDeepEqual(original, updated)
  }
})

test('manifest fixture refuses a symlink outside the isolated result directory', async t => {
  const { root, runtime, entry } = await manifestFixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'plugin-manifest-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const target = join(outside, 'plugin.json')
  await writeFile(target, '{"name":"outside"}')
  const path = join(runtime, '.codex-plugin/plugin.json')
  await rm(path)
  await symlink(target, path)
  await assert.rejects(reformatRuntimeManifests(root, entry))
  assert.equal(await readFile(target, 'utf8'), '{"name":"outside"}')
})

test('fixture rejects Home escapes before touching any files', () => {
  const root = join(tmpdir(), 'plugin-recovery-result')
  assert.throws(() => isolatedPath(root, root))
  assert.throws(() => isolatedPath(root, join(root, '..', 'personal-home')))
  assert.throws(() => relocatedPath('/other-user/plugin', root, join(root, 'next')))
})

test('moving real fixture bytes keeps stale absolute metadata and leaves no bridge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-recovery-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldHome = join(root, 'old-user')
  const oldExecutor = join(root, 'executor-home')
  const nextHome = join(root, 'new-user')
  const store = join(oldHome, 'packages/real-plugin')
  const runtime = join(oldExecutor, 'codex/plugins/cache/wegent/real-plugin/1.0.0')
  await createBusinessPackage(store, 'real-plugin', '1.0.0')
  await mkdir(runtime, { recursive: true })
  await mkdir(join(oldExecutor, 'capabilities'), { recursive: true })
  const manifest = {
    version: 2,
    plugins: {
      'real-plugin@wegent': {
        managed: true,
        installed_plugin_id: 7,
        enabled: false,
        store_path: store,
        runtime: { codex_link: runtime },
      },
    },
  }
  await writeFile(join(oldExecutor, 'capabilities/manifest-v2.json'), JSON.stringify(manifest))
  const nextExecutor = await relocateInstalledHome({
    resultDir: root,
    oldHome,
    oldExecutor,
    newHome: nextHome,
  })
  assert.deepEqual(await readCapabilityManifest(nextExecutor), manifest)
  const entry = pluginEntry(await readCapabilityManifest(nextExecutor), 7)
  assert.equal(entry.enabled, false)
  assert.equal(entry.runtime.codex_link, runtime)
  assert.match(
    await readFile(join(relocatedPath(store, oldHome, nextHome), 'scripts/business.sh'), 'utf8'),
    /PLUGIN_RECOVERY_OK:real-plugin:1.0.0/
  )
  await assert.rejects(readFile(join(oldExecutor, 'capabilities/manifest-v2.json')), {
    code: 'ENOENT',
  })
  await assert.rejects(readFile(join(store, '.codex-plugin/plugin.json')), { code: 'ENOENT' })
})

test('fixture refuses an existing destination and a linked source Home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-recovery-refuse-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldHome = join(root, 'old')
  const oldExecutor = join(root, 'executor')
  const newHome = join(root, 'new')
  await Promise.all([oldHome, oldExecutor, newHome].map(path => mkdir(path)))
  await assert.rejects(relocateInstalledHome({ resultDir: root, oldHome, oldExecutor, newHome }))
  await rm(newHome, { recursive: true })
  const linked = join(root, 'linked-home')
  await symlink(oldHome, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(
    relocateInstalledHome({ resultDir: root, oldHome: linked, oldExecutor, newHome })
  )
})
