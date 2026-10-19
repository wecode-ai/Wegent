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
  relocateInstalledHome,
  relocatedPath,
} from '../e2e/desktop/modules/plugin-runtime-path-fixture.mjs'

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
