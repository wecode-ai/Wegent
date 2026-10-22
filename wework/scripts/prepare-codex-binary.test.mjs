import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  codexTarballName,
  downloadWithRetry,
  resolveCodexLegalSources,
} from './prepare-codex-binary.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('downloadWithRetry', () => {
  test('streams a redirected archive through the default download transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const archive = Buffer.alloc(2 * 1024 * 1024, 'archive')
    const server = createServer((request, response) => {
      response.setHeader('Connection', 'close')
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/archive' }).end()
        return
      }
      response.end(archive)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await downloadWithRetry(`http://127.0.0.1:${server.address().port}/redirect`, destination, {
        attempts: 1,
      })
      expect((await readFile(destination)).equals(archive)).toBe(true)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('rejects a truncated archive and removes its partial file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': 100, Connection: 'close' }).end('partial')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await expect(
        downloadWithRetry(`http://127.0.0.1:${server.address().port}/archive`, destination, {
          attempts: 1,
        })
      ).rejects.toThrow()
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('retries transient failures and removes a partial download', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    await writeFile(destination, 'partial archive')

    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(new Response('complete archive'))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)

    await downloadWithRetry('https://example.test/codex.tgz', destination, {
      fetchImpl,
      sleepImpl,
      retryDelayMs: 10,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 10)
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 20)
    expect(await readFile(destination, 'utf8')).toBe('complete archive')
  })

  test('rejects after the configured number of attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network unavailable'))

    await expect(
      downloadWithRetry('https://example.test/codex.tgz', destination, {
        attempts: 2,
        fetchImpl,
        sleepImpl: vi.fn().mockResolvedValue(undefined),
        retryDelayMs: 0,
      })
    ).rejects.toThrow('network unavailable')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('codexTarballName', () => {
  const entry = {
    version: '0.144.5',
    integrity: 'sha512-test-integrity',
  }

  test('keeps platform archives separate in the shared cache', () => {
    expect(codexTarballName(entry, 'aarch64-apple-darwin')).not.toBe(
      codexTarballName(entry, 'x86_64-apple-darwin')
    )
  })

  test('invalidates a cached archive when its integrity changes', () => {
    expect(codexTarballName(entry, 'aarch64-apple-darwin')).not.toBe(
      codexTarballName(
        { ...entry, integrity: 'sha512-different-integrity' },
        'aarch64-apple-darwin'
      )
    )
  })
})

describe('resolveCodexLegalSources', () => {
  test('selects source license and notice independently', async () => {
    const sources = await resolveCodexLegalSources(
      '/tmp/codex-source',
      '/tmp/bundled/LICENSE',
      '/tmp/bundled/NOTICE',
      async path => basename(path) === 'NOTICE'
    )

    expect(sources).toEqual({
      license: '/tmp/bundled/LICENSE',
      notice: join('/tmp/codex-source', 'NOTICE'),
    })
  })
})
