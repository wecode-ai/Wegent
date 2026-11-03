import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { extractRuntimeArchive } from '../../../scripts/lib/extract-runtime-archive.mjs'
import { hashReleaseAsset } from '../../../scripts/lib/portable-desktop-release.mjs'

/** Install immutable, delivered runtime bytes before preparing mutable source state. */
export async function prepareBundledRuntimeCache(resourcesRoot, runtimeRoot) {
  const resourceRoot = join(resourcesRoot, 'harness-runtime')
  const catalog = JSON.parse(await readFile(join(resourceRoot, 'runtimes.json'), 'utf8'))
  const runtimes = catalog.runtimes.filter(runtime => ['core', 'workbench'].includes(runtime.role))
  assert.deepEqual(new Set(runtimes.map(runtime => runtime.role)), new Set(['core', 'workbench']))
  await mkdir(runtimeRoot, { recursive: true })
  const extracted = new Map()
  for (const runtime of runtimes) {
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
      await mkdir(destination, { recursive: true })
      await extractRuntimeArchive(archive, destination)
      extracted.set(runtime.sourceFingerprint, runtime.archiveSha256)
    }
    const identity = JSON.parse(await readFile(join(destination, 'runtime.json'), 'utf8'))
    assert.equal(identity.dshVersion, runtime.dshVersion)
    assert.equal(identity.sourceFingerprint, runtime.sourceFingerprint)
    assert.ok(identity.role === runtime.role || identity.roles?.includes(runtime.role))
  }
  await writeFile(join(runtimeRoot, 'runtimes.json'), JSON.stringify({ runtimes }) + '\n')
  return runtimeRoot
}
