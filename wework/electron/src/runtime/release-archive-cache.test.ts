import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { encodeReleaseBlocks } from './release-block-map.mjs'
import { releaseArchive } from './release-archive-cache.js'
import type { UpgradeRelease } from './upgrade-policy.mjs'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-cache-'))
  roots.push(root)
  const bytes = 'verified release bytes'
  const release: UpgradeRelease = {
    version: '1.1.0',
    minSourceVersion: '1.0.0',
    sourceSha: 'b'.repeat(40),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.byteLength(bytes),
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
    url: 'https://example.com/release.tar.gz',
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(bytes))
  return { root, release, fetch, bytes }
}

test('reuses a verified archive across controllers without a network request', async () => {
  const { root, release, fetch } = await fixture()
  const downloaded = await releaseArchive(root, release, fetch, () => {})
  const reused = await releaseArchive(root, release, fetch, () => {})
  expect(reused).toEqual({ path: downloaded.path, reused: true })
  expect(fetch).toHaveBeenCalledOnce()
})

test('detects same-size corruption in cached bytes before reuse', async () => {
  const { root, release, fetch, bytes } = await fixture()
  const first = await releaseArchive(root, release, fetch, () => {})
  await writeFile(first.path, 'x'.repeat(bytes.length))
  expect((await releaseArchive(root, release, fetch, () => {})).reused).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(await readFile(first.path, 'utf8')).toBe(bytes)
})

test('never publishes a partial or corrupt download and retains the last valid package', async () => {
  const { root, release, fetch } = await fixture()
  const first = await releaseArchive(root, release, fetch, () => {})
  const invalid = { ...release, sha256: 'a'.repeat(64) }
  await expect(releaseArchive(root, invalid, fetch, () => {})).rejects.toMatchObject({
    code: 'UPDATE_INTEGRITY_FAILED',
    stage: 'verify',
  })
  expect(await readdir(join(root, 'packages'))).toEqual([`${release.sha256}.tar.gz`])
  expect(await readFile(first.path, 'utf8')).toBe('verified release bytes')
})

test('a newer verified package replaces only the obsolete package cache', async () => {
  const { root, release, fetch } = await fixture()
  await releaseArchive(root, release, fetch, () => {})
  const bytes = 'new release bytes'
  const next = {
    ...release,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
  fetch.mockResolvedValueOnce(new Response(bytes))
  const current = await releaseArchive(root, next, fetch, () => {})
  expect(await readdir(join(root, 'packages'))).toEqual([`${next.sha256}.tar.gz`])
  expect(await readFile(current.path, 'utf8')).toBe(bytes)
})

test('downloads only missing byte ranges and verifies the reconstructed archive', async () => {
  const { root, release } = await fixture()
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
  const build = (...parts: string[]) => {
    const body = parts.join('')
    const index = encodeReleaseBlocks(parts.map(part => [Buffer.byteLength(part), hash(part)]))
    return {
      ...release,
      bytes: Buffer.byteLength(body),
      sha256: hash(body),
      index,
      blockMap: { bytes: index.length, sha256: hash(index) },
    }
  }
  const base = build('unchanged', 'old', 'also unchanged')
  await releaseArchive(
    root,
    base,
    async () => new Response('unchangedoldalso unchanged'),
    () => {}
  )
  const target = build('also unchanged', 'new', 'unchanged')
  const body = 'also unchangednewunchanged'
  const requests: Array<string | undefined> = []
  let mode: 'corrupt' | 'range' | 'full' = 'corrupt'
  const server = createServer((request, response) => {
    if (request.url === '/base.tar.gz.blocks') {
      response.end(base.index)
      return
    }
    if (request.url === '/release.tar.gz.blocks') {
      response.end(target.index)
      return
    }
    requests.push(request.headers.range)
    if (mode === 'full') {
      response.writeHead(200).end(body)
      return
    }
    response.writeHead(206, { 'Content-Range': `bytes 14-16/${target.bytes}` })
    response.end(mode === 'corrupt' ? 'bad' : 'new')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test HTTP address')
    base.url = `http://127.0.0.1:${address.port}/base.tar.gz`
    target.url = `http://127.0.0.1:${address.port}/release.tar.gz`
    const indexBytes = base.index.length + target.index.length
    await expect(releaseArchive(root, target, fetch, () => {}, [base])).rejects.toMatchObject({
      code: 'UPDATE_INTEGRITY_FAILED',
    })
    expect(await readdir(join(root, 'packages'))).toEqual([`${base.sha256}.tar.gz`])
    mode = 'range'
    const progress = vi.fn()
    const archive = await releaseArchive(root, target, fetch, progress, [base])
    expect(await readFile(archive.path, 'utf8')).toBe(body)
    expect(progress).toHaveBeenLastCalledWith(indexBytes + 3, indexBytes + 3)

    await releaseArchive(
      root,
      base,
      async () => new Response('unchangedoldalso unchanged'),
      () => {}
    )
    mode = 'full'
    const fromWholeResponse = await releaseArchive(root, target, fetch, progress, [base])
    expect(await readFile(fromWholeResponse.path, 'utf8')).toBe(body)
    expect(progress).toHaveBeenLastCalledWith(indexBytes + target.bytes, indexBytes + target.bytes)
    expect(requests).toEqual(['bytes=14-16', 'bytes=14-16', 'bytes=14-16'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
