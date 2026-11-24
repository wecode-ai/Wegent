import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeReleaseBlocks, type ReleaseBlock } from './release-block-map.mjs'
import type { UpgradeRelease } from './upgrade-policy.mjs'

/** Cache immutable bytes separately from profile-dependent preparation. */
export async function releaseArchive(
  root: string,
  release: UpgradeRelease,
  fetch: typeof globalThis.fetch,
  onProgress: (bytes: number, total: number) => void,
  bases: UpgradeRelease[] = []
): Promise<{ path: string; reused: boolean }> {
  const directory = join(root, 'packages')
  const path = join(directory, `${release.sha256}.tar.gz`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await verifiedArchive(path, release)) return { path, reused: true }
  await rm(path, { force: true })
  const temporary = join(directory, `${release.sha256}.${randomUUID()}.part`)
  try {
    const plan = await archiveTransferPlan(directory, release, bases, fetch)
    await downloadArchive(temporary, release, plan.spans, fetch, (received, total) => {
      onProgress(plan.indexBytes + received, plan.indexBytes + total)
    })
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

type Span = { start: number; bytes: number; source?: { path: string; start: number } }

async function readBlockMap(
  release: UpgradeRelease,
  fetch: typeof globalThis.fetch
): Promise<ReleaseBlock[]> {
  const blockMap = release.blockMap!
  const url = new URL(release.url)
  url.pathname += '.blocks'
  const response = await fetch(url.href)
  const index = Buffer.alloc(blockMap.bytes)
  let offset = 0
  await readResponse(response, index.length, async chunk => {
    index.set(chunk, offset)
    offset += chunk.byteLength
  })
  return decodeReleaseBlocks(index, blockMap, release.bytes)
}

async function archiveTransferPlan(
  directory: string,
  release: UpgradeRelease,
  bases: UpgradeRelease[],
  fetch: typeof globalThis.fetch
): Promise<{ spans: Span[]; indexBytes: number }> {
  const whole = { spans: [{ start: 0, bytes: release.bytes }], indexBytes: 0 }
  if (!release.blockMap) return whole
  const local = new Map<string, { path: string; start: number }>()
  let indexBytes = 0
  for (const base of bases) {
    if (!base.blockMap || base.sha256 === release.sha256) continue
    const path = join(directory, `${base.sha256}.tar.gz`)
    if (!(await verifiedArchive(path, base))) continue
    let start = 0
    for (const [bytes, sha256] of await readBlockMap(base, fetch)) {
      local.set(`${bytes}:${sha256}`, { path, start })
      start += bytes
    }
    indexBytes += base.blockMap.bytes
  }
  if (!local.size) return whole
  const spans: Span[] = []
  let start = 0
  for (const [bytes, sha256] of await readBlockMap(release, fetch)) {
    const source = local.get(`${bytes}:${sha256}`)
    const previous = spans.at(-1)
    if (previous && adjacentSource(previous, source)) previous.bytes += bytes
    else spans.push({ start, bytes, source })
    start += bytes
  }
  return { spans, indexBytes: indexBytes + release.blockMap.bytes }
}

function adjacentSource(previous: Span, source: Span['source']): boolean {
  if (!previous.source || !source) return !previous.source && !source
  return (
    previous.source.path === source.path && previous.source.start + previous.bytes === source.start
  )
}

async function downloadArchive(
  path: string,
  release: UpgradeRelease,
  spans: Span[],
  fetch: typeof globalThis.fetch,
  onProgress: (bytes: number, total: number) => void
): Promise<void> {
  let handle = await open(path, 'wx', 0o600)
  let hash = createHash('sha256')
  let written = 0
  let total = spans.reduce((bytes, span) => bytes + (span.source ? 0 : span.bytes), 0)
  let downloaded = 0
  const write = async (chunk: Uint8Array) => {
    hash.update(chunk)
    written += chunk.byteLength
    await handle.writeFile(chunk)
  }
  const receive = async (chunk: Uint8Array) => {
    await write(chunk)
    downloaded += chunk.byteLength
    onProgress(downloaded, total)
  }
  try {
    onProgress(0, total)
    for (const { start, bytes, source } of spans) {
      if (source) {
        for await (const chunk of createReadStream(source.path, {
          start: source.start,
          end: source.start + bytes - 1,
        }))
          await write(chunk)
        continue
      }
      const end = start + bytes - 1
      const response =
        bytes === release.bytes
          ? await fetch(release.url)
          : await fetch(release.url, { headers: { Range: `bytes=${start}-${end}` } })
      if (response.status === 200 && bytes !== release.bytes) {
        // Servers may ignore Range. Consume that response as the complete archive.
        await handle.close()
        handle = await open(path, 'w', 0o600)
        hash = createHash('sha256')
        written = 0
        total = downloaded + release.bytes
        onProgress(downloaded, total)
        await readResponse(response, release.bytes, receive)
        break
      }
      if (
        bytes !== release.bytes &&
        (response.status !== 206 ||
          response.headers.get('content-range') !== `bytes ${start}-${end}/${release.bytes}`)
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`Invalid release byte range: HTTP ${response.status}`)
      }
      await readResponse(response, bytes, receive)
    }
    if (written !== release.bytes || hash.digest('hex') !== release.sha256)
      throw integrityError('Release package integrity check failed')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readResponse(
  response: Response,
  bytes: number,
  onChunk: (chunk: Uint8Array) => Promise<void>
): Promise<void> {
  if (!response.ok || !response.body)
    throw new Error(`Release download failed: HTTP ${response.status}`)
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > bytes) throw integrityError('Release transfer exceeds declared size')
      await onChunk(value)
    }
    if (received !== bytes) throw integrityError('Release transfer is shorter than declared')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function integrityError(message: string): Error {
  return Object.assign(new Error(message), { code: 'UPDATE_INTEGRITY_FAILED', stage: 'verify' })
}
