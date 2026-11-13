import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  canReuseInstalledSourceSnapshot,
  saveInstalledSourceSnapshot,
  restoreInstalledSourceSnapshot,
} from '../e2e/desktop/modules/installed-source-snapshot.mjs'
import { installPreparedSource } from '../e2e/desktop/modules/installed-source-preparation.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wework-source-snapshot-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDirectory = join(root, 'original')
  const slot = join(dataDirectory, 'releases/slots/source-preparation')
  const content = join(slot, 'managed-components/composed/content')
  const profile = join(slot, 'profile')
  for (const directory of [content, profile]) await mkdir(directory, { recursive: true })
  await writeFile(join(content, 'index.js'), 'delivered program')
  await symlink(
    content,
    join(profile, 'linked-component'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({ dependencies: { component: `file:${content}` } })
  )
  await writeFile(join(profile, 'cordis.yml'), 'initial private configuration')
  await writeFile(
    join(slot, 'prepared.json'),
    JSON.stringify({
      sourceRevision: 'seed',
      components: { weworkCorePlugins: content, contentSha256: { component: 'hash' } },
    })
  )
  await writeFile(
    join(slot, 'release.json'),
    JSON.stringify({
      runtimeRoot: join(dataDirectory, 'managed-runtimes/dsh'),
      profileRoot: profile,
    })
  )
  return {
    root,
    dataDirectory,
    slot,
    cache: join(root, 'cache'),
    identity: { sha256: 'a'.repeat(64), disabled: ['plugin'] },
  }
}

test('restores independent prepared profiles and relocates all owned composition paths', async t => {
  const source = await fixture(t)
  assert.equal(await saveInstalledSourceSnapshot(source), true)
  for (const name of ['first', 'second']) {
    const dataDirectory = join(source.root, name)
    const slot = join(dataDirectory, 'releases/slots/source-preparation')
    assert.equal(await restoreInstalledSourceSnapshot({ ...source, dataDirectory, slot }), true)
    await installPreparedSource(slot, dataDirectory)
    const profile = join(dataDirectory, 'dsh-core/profiles/wework-core')
    const component = join(dataDirectory, 'managed-components/composed/content')
    assert.equal(await realpath(join(profile, 'linked-component')), component)
    assert.deepEqual(
      JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies,
      { component: `file:${component}` }
    )
    assert.equal(
      await readFile(join(profile, 'cordis.yml'), 'utf8'),
      'initial private configuration'
    )
    await writeFile(join(profile, 'cordis.yml'), `checkpoint ${name}`)
    await writeFile(join(component, 'index.js'), `private ${name}`)
    await rm(slot, { recursive: true })
    assert.equal(
      await readFile(join(profile, 'linked-component/index.js'), 'utf8'),
      `private ${name}`
    )
  }
  assert.equal(
    await readFile(join(source.slot, 'profile/cordis.yml'), 'utf8'),
    'initial private configuration'
  )
})

test('reuses a complete snapshot and replaces changed cache entries before restoring', async t => {
  const source = await fixture(t)
  const target = {
    ...source,
    dataDirectory: join(source.root, 'reused'),
    slot: join(source.root, 'reused/slot'),
  }
  assert.equal(await saveInstalledSourceSnapshot(source), true)
  assert.equal(await saveInstalledSourceSnapshot(source), false)
  assert.equal(await canReuseInstalledSourceSnapshot(source), true)
  await writeFile(join(source.cache, 'slot/profile/cordis.yml'), 'corrupted')
  assert.equal(await canReuseInstalledSourceSnapshot(source), false)
  assert.equal(await saveInstalledSourceSnapshot(source), true)
  await mkdir(target.slot, { recursive: true })
  await assert.rejects(restoreInstalledSourceSnapshot(target), { code: 'EEXIST' })
  await rm(target.slot, { recursive: true })
  assert.equal(await restoreInstalledSourceSnapshot(target), true)
  assert.equal(
    await readFile(join(target.slot, 'profile/cordis.yml'), 'utf8'),
    'initial private configuration'
  )
  const identity = { sha256: 'b'.repeat(64), disabled: [] }
  assert.equal(await canReuseInstalledSourceSnapshot({ ...source, identity }), false)
  assert.equal(await saveInstalledSourceSnapshot({ ...source, identity }), true)
  assert.equal(await canReuseInstalledSourceSnapshot({ ...source, identity }), true)
})

test('refuses changed package identity, changed cache bytes, and incomplete snapshots', async t => {
  const source = await fixture(t)
  const target = {
    ...source,
    dataDirectory: join(source.root, 'new'),
    slot: join(source.root, 'new/slot'),
  }
  assert.equal(await restoreInstalledSourceSnapshot(target), false)
  await saveInstalledSourceSnapshot(source)
  await assert.rejects(
    restoreInstalledSourceSnapshot({ ...target, identity: { sha256: 'different' } }),
    /identity differs/
  )
  await writeFile(join(source.cache, 'slot/profile/cordis.yml'), 'corrupted')
  await assert.rejects(restoreInstalledSourceSnapshot(target), /snapshot changed/)
  await rm(join(source.cache, 'snapshot.json'))
  await assert.rejects(restoreInstalledSourceSnapshot(target), { code: 'ENOENT' })
})

test('rebuilds snapshots without relocation origins', async t => {
  const source = await fixture(t)
  assert.equal(await saveInstalledSourceSnapshot(source), true)
  for (const key of ['slot', 'dataDirectory']) {
    const metadata = JSON.parse(await readFile(join(source.cache, 'snapshot.json'), 'utf8'))
    delete metadata[key]
    await writeFile(join(source.cache, 'snapshot.json'), JSON.stringify(metadata))
    assert.equal(await canReuseInstalledSourceSnapshot(source), false)
    assert.equal(await saveInstalledSourceSnapshot(source), true)
    assert.equal(await canReuseInstalledSourceSnapshot(source), true)
  }
})

test('rebuilds cache roots and slots that are not directories', async t => {
  const source = await fixture(t)
  assert.equal(await saveInstalledSourceSnapshot(source), true)
  await rm(source.cache, { recursive: true })
  await writeFile(source.cache, 'not a cache directory')
  assert.equal(await canReuseInstalledSourceSnapshot(source), false)
  assert.equal(await saveInstalledSourceSnapshot(source), true)
  await rm(join(source.cache, 'slot'), { recursive: true })
  await writeFile(join(source.cache, 'slot'), 'not a prepared slot')
  assert.equal(await canReuseInstalledSourceSnapshot(source), false)
  assert.equal(await saveInstalledSourceSnapshot(source), true)
  assert.equal(await canReuseInstalledSourceSnapshot(source), true)
})
