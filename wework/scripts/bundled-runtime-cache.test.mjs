import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareBundledRuntimeCache } from '../e2e/desktop/modules/bundled-runtime-cache.mjs'
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
  return { resources, cache, archive, runtimes, save }
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

test('rejects damaged delivered bytes before installing an initialized source', async t => {
  const { resources, cache, archive } = await fixture(t)
  const bytes = await readFile(archive)
  bytes[bytes.length - 1] ^= 1
  await writeFile(archive, bytes)
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
})

test('rejects conflicting archives for a shared fingerprint and paths outside resources', async t => {
  const { resources, cache, runtimes, save } = await fixture(t)
  runtimes[1].archiveSha256 = 'b'.repeat(64)
  await save()
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
  runtimes[0].assetName = '../runtime.tar.gz'
  await save()
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
})

test('validates each role even when its archive was already extracted for the other role', async t => {
  const { resources, cache, runtimes, save } = await fixture(t)
  runtimes[1].dshVersion = '2.0.0'
  await save()
  await assert.rejects(prepareBundledRuntimeCache(resources, cache))
})
