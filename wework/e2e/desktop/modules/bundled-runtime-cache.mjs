import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { extractRuntimeArchive } from '../../../scripts/lib/extract-runtime-archive.mjs'
import { hashReleaseAsset } from '../../../scripts/lib/portable-desktop-release.mjs'

const descriptorKey = runtime =>
  JSON.stringify(
    Object.fromEntries(Object.entries(runtime).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  )

/** Different host releases can deliver exactly the same immutable runtime set. */
async function bundledRuntimes(resourcesRoot) {
  const catalog = JSON.parse(
    await readFile(join(resourcesRoot, 'harness-runtime/runtimes.json'), 'utf8')
  )
  return catalog.runtimes
    .filter(runtime => ['core', 'workbench'].includes(runtime.role))
    .map(descriptorKey)
    .sort()
    .map(runtime => JSON.parse(runtime))
}

export async function bundledRuntimeCacheKey(resourcesRoot) {
  const runtimes = await bundledRuntimes(resourcesRoot)
  return createHash('sha256').update(JSON.stringify(runtimes)).digest('hex')
}

/** Install immutable, delivered runtime bytes before preparing mutable source state. */
export async function prepareBundledRuntimeCache(resourcesRoot, runtimeRoot, { reuseRoot } = {}) {
  const resourceRoot = join(resourcesRoot, 'harness-runtime')
  const runtimes = await bundledRuntimes(resourcesRoot)
  assert.deepEqual(new Set(runtimes.map(runtime => runtime.role)), new Set(['core', 'workbench']))
  const ready = await readFile(join(runtimeRoot, 'runtimes.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (ready) assert.deepEqual(JSON.parse(ready).runtimes, runtimes)
  await mkdir(runtimeRoot, { recursive: true })
  if (!ready)
    assert.equal((await readdir(runtimeRoot)).length, 0, 'A previous runtime installation failed')
  const reusable = reuseRoot
    ? JSON.parse(await readFile(join(reuseRoot, 'runtimes.json'), 'utf8')).runtimes
    : []
  assert.ok(Array.isArray(reusable), 'The reusable runtime catalog is invalid')
  const extracted = new Map()
  for (const runtime of runtimes) {
    if (!ready && reuseRoot)
      assert.ok(
        reusable.some(candidate => descriptorKey(candidate) === descriptorKey(runtime)),
        'The reusable runtime differs from the delivered source'
      )
    assert.match(runtime.sourceFingerprint, /^[0-9a-f]{64}$/)
    assert.match(runtime.archiveSha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isSafeInteger(runtime.archiveBytes) && runtime.archiveBytes > 0)
    assert.equal(basename(runtime.assetName), runtime.assetName)
    assert.ok(!/[\\/]/.test(runtime.assetName) && runtime.assetName.endsWith('.tar.gz'))
    const archive = join(resourceRoot, runtime.assetName)
    const destination = join(runtimeRoot, runtime.sourceFingerprint)
    if (extracted.has(runtime.sourceFingerprint)) {
      assert.equal(extracted.get(runtime.sourceFingerprint), runtime.archiveSha256)
    } else {
      assert.equal((await stat(archive)).size, runtime.archiveBytes)
      assert.equal(await hashReleaseAsset(archive), runtime.archiveSha256)
      if (!ready) {
        if (reuseRoot) {
          const content = await realpath(join(reuseRoot, runtime.sourceFingerprint))
          await assertRuntimeIdentity(content, runtime)
          await symlink(content, destination, process.platform === 'win32' ? 'junction' : 'dir')
        } else {
          await mkdir(destination)
          await extractRuntimeArchive(archive, destination)
        }
      }
      extracted.set(runtime.sourceFingerprint, runtime.archiveSha256)
    }
    await assertRuntimeIdentity(destination, runtime)
  }
  if (!ready)
    await writeFile(join(runtimeRoot, 'runtimes.json'), JSON.stringify({ runtimes }) + '\n')
  return runtimeRoot
}

async function assertRuntimeIdentity(destination, runtime) {
  const identity = JSON.parse(await readFile(join(destination, 'runtime.json'), 'utf8'))
  assert.equal(identity.dshVersion, runtime.dshVersion)
  assert.equal(identity.sourceFingerprint, runtime.sourceFingerprint)
  assert.ok(identity.role === runtime.role || identity.roles?.includes(runtime.role))
}

/** Keep every checkpoint's mutable catalog separate from shared immutable files. */
export async function linkBundledRuntimeCache(cacheRoot, runtimeRoot) {
  const { runtimes } = JSON.parse(await readFile(join(cacheRoot, 'runtimes.json'), 'utf8'))
  await mkdir(runtimeRoot, { recursive: true })
  const linked = new Set()
  for (const runtime of runtimes) {
    assert.match(runtime.sourceFingerprint, /^[0-9a-f]{64}$/)
    const content = join(cacheRoot, runtime.sourceFingerprint)
    await assertRuntimeIdentity(content, runtime)
    const destination = join(runtimeRoot, runtime.sourceFingerprint)
    if (!linked.has(runtime.sourceFingerprint)) {
      await symlink(content, destination, process.platform === 'win32' ? 'junction' : 'dir').catch(
        error => {
          if (error.code !== 'EEXIST') throw error
        }
      )
      linked.add(runtime.sourceFingerprint)
    }
    await assertRuntimeIdentity(destination, runtime)
  }
  await writeFile(join(runtimeRoot, 'runtimes.json'), JSON.stringify({ runtimes }) + '\n')
}
