import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { downloadWithRetry } from './prepare-codex-binary.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('downloadWithRetry', () => {
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
