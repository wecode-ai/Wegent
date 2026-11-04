import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  bundledRuntimeCacheKey,
  linkBundledRuntimeCache,
  prepareBundledRuntimeCache,
} from '../e2e/desktop/modules/bundled-runtime-cache.mjs'
import { hashReleaseAsset } from './lib/portable-desktop-release.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wework-installed-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const resources = join(root, 'resources')
  const bundled = join(resources, 'harness-runtime')
  const cache = join(root, 'cache')
  await mkdir(source)
  await mkdir(bundled, { recursive: true })
  const identity = {
    dshVersion: '1.0.0',
    sourceFingerprint: 'a'.repeat(64),
    roles: ['core', 'workbench'],
  }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(identity))
  await writeFile(join(source, 'module.js'), 'export const value = 42\n')
  const archive = join(bundled, 'runtime.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', source, '.'])
  const descriptor = {
    ...identity,
    assetName: 'runtime.tar.gz',
    archiveBytes: (await stat(archive)).size,
    archiveSha256: await hashReleaseAsset(archive),
  }
  const runtimes = ['core', 'workbench'].map(role => ({ ...descriptor, role }))
  const save = () => writeFile(join(bundled, 'runtimes.json'), JSON.stringify({ runtimes }))
  await save()
  return { root, resources, cache, archive, runtimes, save }
}

test('installs the exact bundled runtime for both roles without changing package bytes', async t => {
  const { resources, cache, archive, runtimes } = await fixture(t)
  await prepareBundledRuntimeCache(resources, cache)
  assert.equal(await hashReleaseAsset(archive), runtimes[0].archiveSha256)
  assert.equal(
    await readFile(join(cache, runtimes[0].sourceFingerprint, 'module.js'), 'utf8'),
    'export const value = 42\n'
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(cache, 'runtimes.json'), 'utf8')).runtimes,
    runtimes
  )
})

test('runtime cache identity follows delivered runtime metadata rather than host version or key order', async t => {
  const { resources, cache, runtimes, save } = await fixture(t)
  const key = await bundledRuntimeCacheKey(resources)
  await prepareBundledRuntimeCache(resources, cache)
  runtimes.reverse()
  for (let index = 0; index < runtimes.length; index++)
    runtimes[index] = Object.fromEntries(Object.entries(runtimes[index]).reverse())
  await save()
  assert.equal(await bundledRuntimeCacheKey(resources), key)
  await prepareBundledRuntimeCache(resources, cache)
  runtimes[0].archiveSha256 = 'e'.repeat(64)
  await save()
  assert.notEqual(await bundledRuntimeCacheKey(resources), key)
})

test('rejects damaged delivered bytes before installing an initialized source', async t => {
  const { resources, cache, archive } = await fixture(t)
  const bytes = await readFile(archive)
  bytes[bytes.length - 1] ^= 1
  await writeFile(archive, bytes)
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
})

test('rejects conflicting archives for a shared fingerprint', async t => {
  const { resources, cache, runtimes, save } = await fixture(t)
  runtimes[1].archiveSha256 = 'b'.repeat(64)
  await save()
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
})

test('rejects archive paths outside resources before opening the archive', async t => {
  const { resources, cache, runtimes, save } = await fixture(t)
  runtimes[0].assetName = '../runtime.tar.gz'
  await save()
  await assert.rejects(prepareBundledRuntimeCache(resources, cache), { code: 'ERR_ASSERTION' })
})

test('validates each role even when its archive was already extracted for the other role', async t => {
  const { resources, cache, runtimes, save } = await fixture(t)
  runtimes[1].dshVersion = '2.0.0'
  await save()
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
})

test('reuses immutable files across checkpoints while keeping catalogs and cleanup isolated', async t => {
  const { root, resources, cache, runtimes } = await fixture(t)
  await prepareBundledRuntimeCache(resources, cache)
  const file = join(cache, runtimes[0].sourceFingerprint, 'module.js')
  const original = await stat(file)
  const first = join(root, 'checkpoint-one')
  await linkBundledRuntimeCache(cache, first)
  await writeFile(join(first, 'runtimes.json'), JSON.stringify({ runtimes: [] }))
  await rm(first, { recursive: true, force: true })

  await prepareBundledRuntimeCache(resources, cache)
  const second = join(root, 'checkpoint-two')
  await linkBundledRuntimeCache(cache, second)

  assert.equal((await stat(file)).ctimeMs, original.ctimeMs)
  assert.equal(
    await readFile(join(second, runtimes[0].sourceFingerprint, 'module.js'), 'utf8'),
    'export const value = 42\n'
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(second, 'runtimes.json'), 'utf8')).runtimes,
    runtimes
  )
})

test('reuses exact target programs after temporary catalog cleanup without adding target-only roles', async t => {
  const { root, resources, cache, runtimes } = await fixture(t)
  await prepareBundledRuntimeCache(resources, cache)
  const temporary = join(root, 'target-private-catalog')
  await linkBundledRuntimeCache(cache, temporary)
  await writeFile(
    join(temporary, 'runtimes.json'),
    JSON.stringify({
      runtimes: [
        ...runtimes,
        { ...runtimes[1], dshVersion: '0.5.0', sourceFingerprint: 'b'.repeat(64) },
      ],
    })
  )
  const source = join(root, 'source-catalog')
  await prepareBundledRuntimeCache(resources, source, { reuseRoot: temporary })
  await rm(temporary, { recursive: true, force: true })
  assert.equal(
    await realpath(join(source, runtimes[0].sourceFingerprint)),
    await realpath(join(cache, runtimes[0].sourceFingerprint))
  )
  assert.equal(
    await readFile(join(source, runtimes[0].sourceFingerprint, 'module.js'), 'utf8'),
    'export const value = 42\n'
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(source, 'runtimes.json'), 'utf8')).runtimes,
    runtimes
  )
})

test('reusing target programs still rejects a corrupt source archive', async t => {
  const { root, resources, cache, archive } = await fixture(t)
  await prepareBundledRuntimeCache(resources, cache)
  const bytes = await readFile(archive)
  bytes[bytes.length - 1] ^= 1
  await writeFile(archive, bytes)
  await assert.rejects(
    prepareBundledRuntimeCache(resources, join(root, 'source-catalog'), { reuseRoot: cache })
  )
})

for (const mismatch of ['archiveSha256', 'role']) {
  test(`rejects a reusable target with a different ${mismatch}`, async t => {
    const { root, resources, cache, runtimes } = await fixture(t)
    await prepareBundledRuntimeCache(resources, cache)
    const changed = runtimes.map(runtime => ({ ...runtime }))
    changed[1][mismatch] = mismatch === 'role' ? 'unknown' : 'b'.repeat(64)
    await writeFile(join(cache, 'runtimes.json'), JSON.stringify({ runtimes: changed }))
    await assert.rejects(
      prepareBundledRuntimeCache(resources, join(root, 'source-catalog'), { reuseRoot: cache }),
      /reusable runtime differs/
    )
  })
}

test('a warmed cache does not bypass verification of the delivered archive', async t => {
  const { resources, cache, archive } = await fixture(t)
  await prepareBundledRuntimeCache(resources, cache)
  const bytes = await readFile(archive)
  bytes[bytes.length - 1] ^= 1
  await writeFile(archive, bytes)
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
})

test('parallel warmed readers validate archives without rewriting the shared catalog', async t => {
  const { resources, cache } = await fixture(t)
  await prepareBundledRuntimeCache(resources, cache)
  const catalog = join(cache, 'runtimes.json')
  const original = await stat(catalog)
  await Promise.all([
    prepareBundledRuntimeCache(resources, cache),
    prepareBundledRuntimeCache(resources, cache),
  ])
  const after = await stat(catalog)
  assert.equal(after.mtimeMs, original.mtimeMs)
  assert.equal(after.ctimeMs, original.ctimeMs)
})

test('an incomplete installation fails without retrying extraction or deleting diagnostics', async t => {
  const { resources, cache } = await fixture(t)
  await mkdir(cache)
  await writeFile(join(cache, 'partial-result'), 'failed producer')
  await assert.rejects(
    prepareBundledRuntimeCache(resources, cache),
    /previous runtime installation failed/
  )
  assert.equal(await readFile(join(cache, 'partial-result'), 'utf8'), 'failed producer')
})
