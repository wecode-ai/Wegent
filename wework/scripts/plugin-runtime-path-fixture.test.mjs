// @vitest-environment node

import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'

import {
  createBusinessPackage,
  isolatedPath,
  pluginEntry,
  readCapabilityManifest,
  reformatRuntimeManifests,
  relocateInstalledHome,
  relocatedPath,
  runtimeRootMetadata,
  rewriteRuntimeManifests,
} from '../e2e/desktop/modules/plugin-runtime-path-fixture.mjs'

async function manifestFixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-manifest-fixture-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
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

test('formatting fixture changes both root manifest bytes without changing JSON or scripts', async () => {
  const { root, runtime, entry } = await manifestFixture()
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

test('semantic fixtures change a field and array order without changing plugin identity', async () => {
  const { root, entry } = await manifestFixture()
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

test('manifest fixture refuses a symlink outside the isolated result directory', async () => {
  const { root, runtime, entry } = await manifestFixture()
  const outside = await mkdtemp(join(tmpdir(), 'plugin-manifest-outside-'))
  onTestFinished(() => rm(outside, { recursive: true, force: true }))
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

test('moving real fixture bytes keeps stale absolute metadata and leaves no bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-recovery-fixture-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
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

test('fixture refuses an existing destination and a linked source Home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-recovery-refuse-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
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

test('runtime root diagnostics inspect metadata without contents or symlink targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-root-metadata-'))
  const outside = await mkdtemp(join(tmpdir(), 'plugin-root-outside-'))
  onTestFinished(() =>
    Promise.all([root, outside].map(path => rm(path, { recursive: true, force: true })))
  )
  const executor = join(root, 'executor-home')
  await mkdir(join(executor, 'codex'), { recursive: true })
  await writeFile(join(executor, 'codex/auth.json'), 'PRIVATE_CREDENTIAL_DO_NOT_READ')
  await writeFile(join(outside, 'outside-secret.txt'), 'PRIVATE_OUTSIDE_DO_NOT_READ')
  await symlink(
    outside,
    join(executor, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  const report = await runtimeRootMetadata(root, executor)
  assert.equal(report.root, 'executor-home')
  assert.equal(report.truncated, false)
  assert.equal(report.errorCode, undefined)
  assert.ok(report.entries.some(entry => entry.path === 'codex/auth.json' && entry.type === 'file'))
  assert.ok(report.entries.some(entry => entry.path === 'linked' && entry.type === 'symlink'))
  for (const entry of report.entries) {
    assert.ok(Number.isFinite(Date.parse(entry.modifiedAt)))
    assert.ok(Number.isFinite(Date.parse(entry.createdAt)))
  }
  const serialized = JSON.stringify(report)
  for (const privateValue of [
    'PRIVATE_CREDENTIAL',
    'PRIVATE_OUTSIDE',
    'outside-secret.txt',
    outside,
  ]) {
    assert.equal(serialized.includes(privateValue), false)
  }
  assert.equal(
    (await runtimeRootMetadata(root, join(executor, 'linked/nested'))).errorCode,
    'SYMLINK_ANCESTOR'
  )
})

test('runtime root diagnostics bound entry count and depth without creating absent roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-root-limits-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const absent = join(root, 'absent-executor')
  assert.equal((await runtimeRootMetadata(root, absent)).errorCode, 'ENOENT')
  await assert.rejects(lstat(absent), { code: 'ENOENT' })
  await assert.rejects(runtimeRootMetadata(root, join(root, '..', 'outside')))
  const many = join(root, 'many')
  await mkdir(many)
  await Promise.all(
    Array.from({ length: 40 }, (_, index) => writeFile(join(many, `${index}`), 'x'))
  )
  const bounded = await runtimeRootMetadata(root, many)
  assert.equal(bounded.entries.length, 32)
  assert.equal(bounded.truncated, true)
  const deep = join(root, 'deep')
  await mkdir(join(deep, 'one/two/three/four'), { recursive: true })
  const nested = await runtimeRootMetadata(root, deep)
  assert.equal(nested.truncated, true)
  assert.ok(nested.entries.some(entry => entry.path === 'one/two/three'))
  assert.equal(
    nested.entries.some(entry => entry.path.includes('four')),
    false
  )
})
