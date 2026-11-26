// @vitest-environment node

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

test('direct execution through a directory link still runs the native preparation command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-codex-main-'))
  temporaryDirectories.push(directory)
  const root = join(directory, 'actual')
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  await cp(
    new URL('./prepare-codex-binary.mjs', import.meta.url),
    join(root, 'scripts/prepare-codex-binary.mjs')
  )
  await cp(
    new URL('./lib/process-lock.mjs', import.meta.url),
    join(root, 'scripts/lib/process-lock.mjs')
  )
  await writeFile(join(root, 'codex-binaries.lock.json'), '{"targets":{}}')
  await symlink(
    resolve('node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const alias = join(directory, 'alias')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(
    promisify(execFile)(process.execPath, [
      join(alias, 'scripts/prepare-codex-binary.mjs'),
      '--target',
      'unsupported-goal-test',
    ])
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Unsupported Codex target: unsupported-goal-test'),
  })
})

describe('downloadWithRetry', () => {
  test('streams a redirected archive through the default download transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const archive = Buffer.alloc(2 * 1024 * 1024, 'archive')
    const server = createServer((request, response) => {
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

  test('destroys the body when rejecting too many redirects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const server = createServer((request, response) => {
      const redirectNumber = Number(new URL(request.url, 'http://localhost').searchParams.get('n'))
      response.writeHead(302, { Location: '/?n=' + (redirectNumber + 1) })
      response.end(Buffer.alloc(128 * 1024))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      await expect(
        downloadWithRetry('http://127.0.0.1:' + server.address().port + '/?n=1', destination, {
          attempts: 1,
          timeouts: {
            connectTimeoutMs: 1_000,
            headersTimeoutMs: 1_000,
            bodyTimeoutMs: 1_000,
          },
        })
      ).rejects.toThrow('Too many download redirects')
    } finally {
      server.closeAllConnections?.()
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

    const downloadImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockImplementation(async (_url, destination) => {
        await writeFile(destination, 'complete archive')
      })
    const sleepImpl = vi.fn().mockResolvedValue(undefined)

    await downloadWithRetry('https://example.test/codex.tgz', destination, {
      downloadImpl,
      sleepImpl,
      retryDelayMs: 10,
    })

    expect(downloadImpl).toHaveBeenCalledTimes(3)
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 10)
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 20)
    expect(await readFile(destination, 'utf8')).toBe('complete archive')
  })

  test('rejects after the configured number of attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const downloadImpl = vi.fn().mockRejectedValue(new Error('network unavailable'))

    await expect(
      downloadWithRetry('https://example.test/codex.tgz', destination, {
        attempts: 2,
        downloadImpl,
        sleepImpl: vi.fn().mockResolvedValue(undefined),
        retryDelayMs: 0,
      })
    ).rejects.toThrow('network unavailable')
    expect(downloadImpl).toHaveBeenCalledTimes(2)
  })

  test('rejects a stalled response and retries it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Length': 32 })
      response.write('partial')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const attempts = 2

    try {
      await downloadWithRetry(`http://127.0.0.1:${server.address().port}/archive`, destination, {
        attempts,
        sleepImpl,
        retryDelayMs: 10,
        timeouts: {
          connectTimeoutMs: 1_000,
          headersTimeoutMs: 1_000,
          bodyTimeoutMs: 50,
        },
      })
      throw new Error('Expected the stalled download to fail')
    } catch (error) {
      expect(error.message).toBe('Body Timeout Error')
    } finally {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }

    expect(sleepImpl).toHaveBeenCalledTimes(attempts - 1)
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('routes downloads through the configured proxy environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-codex-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'codex.tgz')
    const archive = Buffer.from('proxied archive')
    const proxyServer = createServer((request, response) => {
      expect(request.url).toBe('http://example.test/codex.tgz')
      response.end(archive)
    })
    await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve))
    const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`
    const previousEnvironment = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    }
    process.env.HTTP_PROXY = proxyUrl
    process.env.http_proxy = proxyUrl
    process.env.NO_PROXY = ''
    process.env.no_proxy = ''

    try {
      await downloadWithRetry('http://example.test/codex.tgz', destination, {
        attempts: 1,
        timeouts: {
          connectTimeoutMs: 1_000,
          headersTimeoutMs: 1_000,
          bodyTimeoutMs: 50,
        },
      })
      expect((await readFile(destination)).equals(archive)).toBe(true)
    } finally {
      proxyServer.closeAllConnections?.()
      await new Promise(resolve => proxyServer.close(resolve))
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
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
