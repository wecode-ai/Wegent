import { ZipArchive } from 'archiver'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as yauzl from 'yauzl'
import { SmartAppManager } from './smart-app-manager.js'

vi.mock('electron', () => ({
  net: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
}))

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Smart App archive installation regression', () => {
  test('downloads, previews, installs and updates large compressed entries without losing bytes', async () => {
    const { root, manager } = await fixture()
    const payloads = [randomBytes(256 * 1024), randomBytes(384 * 1024)]
    const archives = await Promise.all(
      payloads.map((bytes, index) => release(root, `${index + 1}.0.0`, bytes))
    )
    const server = createServer((request, response) =>
      response.end(archives[Number(request.url?.slice(1))])
    )
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address')

    try {
      for (const [index, bytes] of archives.entries()) {
        const preview = await manager.download({
          downloadUrl: `http://127.0.0.1:${address.port}/${index}`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
          smartAppId: 7,
          releaseId: index + 1,
        })
        expect(preview.valid).toBe(true)
        const installed = await manager.install({
          archivePath: preview.archivePath,
          expectedSha256: preview.sha256,
          smartAppId: 7,
          releaseId: index + 1,
        })

        expect(installed.manifest.version).toBe(`${index + 1}.0.0`)
        const extracted = await readFile(join(installed.packagePath, 'app/client.js'))
        expect(extracted.equals(payloads[index]!)).toBe(true)
        expect(await manager.list()).toEqual([installed])
        await expect(stagingDirectories(root)).resolves.toEqual([])
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })

  test.each(['preview', 'installation'])(
    'releases the queue after a %s extraction timeout, preserves the old version and permits retry',
    async phase => {
      const { root, manager } = await fixture()
      const first = join(root, 'first.zip')
      const second = join(root, 'second.zip')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(first, await release(root, '1.0.0', Buffer.from('original')))
      await writeFile(second, await release(root, '2.0.0', randomBytes(256 * 1024)))
      const originalPreview = await manager.preview(first)
      const original = await manager.install({
        archivePath: first,
        expectedSha256: originalPreview.sha256,
      })
      const expectedSha256 = createHash('sha256')
        .update(await readFile(second))
        .digest('hex')
      const stalled = new Readable({ read() {} })
      let started!: () => void
      const streamStarted = new Promise<void>(resolve => {
        started = resolve
      })
      const openReadStream = yauzl.ZipFile.prototype.openReadStreamPromise
      const openedZips = new Set<yauzl.ZipFile>()
      const open = vi
        .spyOn(yauzl.ZipFile.prototype, 'openReadStreamPromise')
        .mockImplementation(async function (this: yauzl.ZipFile, entry, options) {
          openedZips.add(this)
          if (phase === 'installation' && openedZips.size === 1) {
            return openReadStream.call(this, entry, options)
          }
          started()
          return stalled
        })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const failed = expect(
        manager.install({ archivePath: second, expectedSha256 })
      ).rejects.toThrow('Smart app ZIP extraction timed out')
      const queuedList = manager.list()
      await streamStarted
      await vi.advanceTimersByTimeAsync(60_000)
      await failed

      expect(stalled.destroyed).toBe(true)
      await expect(queuedList).resolves.toEqual([original])
      await expect(stagingDirectories(root)).resolves.toEqual([])
      open.mockRestore()
      vi.useRealTimers()
      const updated = await manager.install({ archivePath: second, expectedSha256 })
      expect(updated.manifest.version).toBe('2.0.0')
      expect(await manager.list()).toEqual([updated])
    }
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-installation-'))
  roots.push(root)
  const manager = new SmartAppManager({
    dataDirectory: root,
    documentsDirectory: () => root,
    downloadsDirectory: () => root,
    logDirectory: root,
    runtimeRoot: root,
    environment: {},
    runtimeHost: () => null,
  })
  return { root, manager }
}

async function stagingDirectories(root: string) {
  return (await readdir(join(root, 'harness-apps'))).filter(name =>
    /^\.(?:preview|install)-/.test(name)
  )
}

async function release(root: string, version: string, payload: Buffer): Promise<Buffer> {
  const path = join(root, `release-${version}.zip`)
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.append(
      JSON.stringify({
        name: 'archive-regression',
        displayName: 'Archive Regression',
        version,
        type: 'deepseek-harness-plugin-bundle',
        entry: { installPackage: 'app', profile: 'fixture' },
        requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
      }),
      { name: 'plugin-manifest.json' }
    )
    archive.append(JSON.stringify({ name: 'archive-regression', version }), {
      name: 'app/package.json',
    })
    archive.append(payload, { name: 'app/client.js' })
    void archive.finalize()
  })
  return readFile(path)
}
