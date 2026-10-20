import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RuntimeDescriptor } from './bundled-runtime-materializer.js'
import { createDownloadInactivityTimeout } from './download-timeout.js'

export async function resolveRuntimeArchive(
  resourceRoot: string,
  cacheRoot: string,
  runtime: RuntimeDescriptor,
  fetchImpl: typeof fetch
): Promise<string> {
  const bundled = join(resourceRoot, runtime.assetName)
  try {
    await stat(bundled)
    if (!(await archiveMatches(bundled, runtime))) {
      throw new Error(`Bundled DSH runtime integrity mismatch: ${runtime.assetName}`)
    }
    return bundled
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const archives = join(cacheRoot, 'archives')
  const target = join(archives, runtime.assetName)
  if (await archiveMatches(target, runtime)) return target
  const url = new URL(runtime.downloadUrl ?? '')
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('DSH runtime downloads require HTTPS without credentials')
  }
  await mkdir(archives, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(archives, '.download-'))
  try {
    const archive = join(temporary, 'runtime.tar.gz')
    await downloadArchive(url, archive, runtime, fetchImpl)
    await rm(target, { force: true })
    await rename(archive, target)
    return target
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function archiveMatches(path: string, runtime: RuntimeDescriptor): Promise<boolean> {
  try {
    if ((await stat(path)).size !== runtime.archiveBytes) return false
    const hash = createHash('sha256')
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex') === runtime.archiveSha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function downloadArchive(
  url: URL,
  destination: string,
  runtime: RuntimeDescriptor,
  fetchImpl: typeof fetch
): Promise<void> {
  const timeout = createDownloadInactivityTimeout(60_000)
  try {
    await streamArchive(url, destination, runtime, fetchImpl, timeout)
  } finally {
    timeout.clear()
  }
}

async function streamArchive(
  url: URL,
  destination: string,
  runtime: RuntimeDescriptor,
  fetchImpl: typeof fetch,
  timeout: ReturnType<typeof createDownloadInactivityTimeout>
): Promise<void> {
  const response = await fetchImpl(url.href, { signal: timeout.signal })
  if (!response.ok || !response.body) {
    throw new Error(`DSH runtime download failed: HTTP ${response.status} (${runtime.dshVersion})`)
  }
  timeout.refresh()
  const hash = createHash('sha256')
  let bytes = 0
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    async function* (source) {
      for await (const chunk of source) {
        timeout.refresh()
        bytes += chunk.length
        if (bytes > runtime.archiveBytes) throw new Error('DSH runtime download size mismatch')
        hash.update(chunk)
        yield chunk
      }
    },
    createWriteStream(destination, { mode: 0o600, flags: 'wx' })
  )
  if (bytes !== runtime.archiveBytes) throw new Error('DSH runtime download size mismatch')
  if (hash.digest('hex') !== runtime.archiveSha256) {
    throw new Error('DSH runtime download checksum mismatch')
  }
}
