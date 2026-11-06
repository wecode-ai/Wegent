import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpgradeRelease } from './upgrade-policy.mjs'

/** Cache immutable bytes separately from profile-dependent preparation. */
export async function releaseArchive(
  root: string,
  release: UpgradeRelease,
  fetch: typeof globalThis.fetch,
  onProgress: (bytes: number) => void
): Promise<{ path: string; reused: boolean }> {
  const directory = join(root, 'packages')
  const path = join(directory, `${release.sha256}.tar.gz`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await verifiedArchive(path, release)) return { path, reused: true }
  await rm(path, { force: true })
  const temporary = join(directory, `${release.sha256}.${randomUUID()}.part`)
  try {
    await downloadArchive(temporary, release, fetch, onProgress)
    await rename(temporary, path)
    // Only the pending package needs a cache. Keep cleanup outside release slots
    // so plugin data and rollback resources never participate in this policy.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^[a-f0-9]{64}\.tar\.gz$/.test(entry.name) &&
        entry.name !== `${release.sha256}.tar.gz`
      )
        await rm(join(directory, entry.name), { force: true })
    }
    return { path, reused: false }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function verifiedArchive(path: string, release: UpgradeRelease): Promise<boolean> {
  try {
    if ((await stat(path)).size !== release.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === release.sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function downloadArchive(
  path: string,
  release: UpgradeRelease,
  fetch: typeof globalThis.fetch,
  onProgress: (bytes: number) => void
): Promise<void> {
  const response = await fetch(release.url)
  if (!response.ok || !response.body)
    throw new Error(`Release download failed: HTTP ${response.status}`)
  const handle = await open(path, 'wx', 0o600)
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > release.bytes) throw integrityError('Release package exceeds declared size')
      hash.update(value)
      await handle.writeFile(value)
      onProgress(received)
    }
    if (received !== release.bytes || hash.digest('hex') !== release.sha256)
      throw integrityError('Release package integrity check failed')
    await handle.sync()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await handle.close()
  }
}

function integrityError(message: string): Error {
  return Object.assign(new Error(message), { code: 'UPDATE_INTEGRITY_FAILED', stage: 'verify' })
}
