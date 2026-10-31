import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// The first native Windows arm64 release has no published 0.1.0-rc.8 arm64
// runtime. There are no pre-existing arm64 clients that could request it.
export function legacyDshRuntimeIsPublished(platform = process.platform, arch = process.arch) {
  return !(platform === 'win32' && arch === 'arm64')
}

export async function verifyDefaultOnlyDshPackage(resourceRoot, runtimeRoot) {
  const catalog = JSON.parse(await readFile(join(resourceRoot, 'runtimes.json'), 'utf8'))
  assert.deepEqual(
    [...new Set(catalog.runtimes.map(runtime => runtime.dshVersion))],
    ['0.2.0-rc.2']
  )
  assert.equal(
    (await readdir(runtimeRoot)).includes('archives'),
    false,
    'The scenario must start without downloaded runtime archives'
  )
  const legacy = catalog.downloadableRuntimes.find(runtime => runtime.dshVersion === '0.1.0-rc.8')
  if (!legacyDshRuntimeIsPublished()) {
    assert.equal(
      legacy,
      undefined,
      'The first Windows arm64 release must not advertise a nonexistent legacy runtime'
    )
    return
  }
  assert.ok(legacy, 'The package must retain the pinned legacy runtime download descriptor')
  await assert.rejects(stat(join(resourceRoot, legacy.assetName)), { code: 'ENOENT' })
  await assert.rejects(stat(join(runtimeRoot, legacy.sourceFingerprint)), { code: 'ENOENT' })
}

export async function verifyDownloadedDshRuntimeCache(runtimeRoot, version) {
  const catalog = JSON.parse(await readFile(join(runtimeRoot, 'runtimes.json'), 'utf8'))
  const runtime = catalog.runtimes.find(
    item => item.role === 'workbench' && item.dshVersion === version
  )
  assert.ok(runtime, `Downloaded DSH ${version} must be registered in the runtime cache`)
  assert.match(
    runtime.downloadUrl,
    /^https:\/\/github\.com\/wecode-ai\/Wegent\/releases\/download\/wework-updater\//
  )
  const archivePath = join(runtimeRoot, 'archives', runtime.assetName)
  const bytes = await readFile(archivePath)
  assert.equal(
    bytes.length,
    runtime.archiveBytes,
    'Downloaded DSH archive size must match its pinned descriptor'
  )
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    runtime.archiveSha256,
    'Downloaded DSH archive SHA-256 must match its pinned descriptor'
  )
  const identity = JSON.parse(
    await readFile(join(runtimeRoot, runtime.sourceFingerprint, 'runtime.json'), 'utf8')
  )
  assert.equal(identity.dshVersion, version)
  assert.equal(identity.sourceFingerprint, runtime.sourceFingerprint)
  const metadata = await stat(archivePath)
  return { assetName: runtime.assetName, mtimeMs: metadata.mtimeMs, bytes: metadata.size }
}
