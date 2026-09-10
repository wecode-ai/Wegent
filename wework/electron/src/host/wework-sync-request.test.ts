import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWeworkSyncFetchInit,
  createWeworkSyncRequestSignal,
  normalizeWeworkSyncApiBaseUrl,
  normalizeWeworkSyncPath,
  readWeworkSyncResponse,
  WEWORK_SYNC_REQUEST_TIMEOUT_MS,
} from './wework-sync-request.js'

describe('Wework sync request normalization', () => {
  test('preserves allowed transcript and plugin-storage query parameters', () => {
    expect(normalizeWeworkSyncPath('/wework-transcripts?includeArchived=true')).toBe(
      '/wework-transcripts?includeArchived=true'
    )
    expect(
      normalizeWeworkSyncPath('/wework-transcripts/task-1/archives/4/turns?after=0&limit=1000')
    ).toBe('/wework-transcripts/task-1/archives/4/turns?after=0&limit=1000')
    expect(
      normalizeWeworkSyncPath(
        '/v1/dsh-plugin-storage/units/preferences/load?package=%40wegent%2Fsync'
      )
    ).toBe('/v1/dsh-plugin-storage/units/preferences/load?package=%40wegent%2Fsync')
  })

  test.each([
    'https://attacker.example/wework-transcripts',
    '//attacker.example/wework-transcripts',
    '/other-service',
    '/wework-transcripts#outside',
  ])('rejects a path outside the synchronization API: %s', path => {
    expect(() => normalizeWeworkSyncPath(path)).toThrow('Wework sync path is not allowed')
  })

  test('normalizes the API base URL without credentials, query, or hash', () => {
    expect(normalizeWeworkSyncApiBaseUrl('https://cloud.example.com/api/?ignored=1#hash')).toBe(
      'https://cloud.example.com/api'
    )
    expect(() =>
      normalizeWeworkSyncApiBaseUrl('https://user:secret@cloud.example.com/api')
    ).toThrow('Invalid Wework sync API URL')
  })

  test('bounds an unavailable backend request without blocking the desktop', async () => {
    expect(WEWORK_SYNC_REQUEST_TIMEOUT_MS).toBe(30_000)
    const signal = createWeworkSyncRequestSignal(1)
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    expect(signal.aborted).toBe(true)
  })

  test('builds authenticated multipart uploads to the backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-sync-upload-'))
    const path = join(directory, 'segment.enc')
    await writeFile(path, 'encrypted transcript')

    const request = await createWeworkSyncFetchInit(
      {
        apiBaseUrl: 'https://cloud.example.com/api',
        path: '/wework-transcripts/task-1/segments',
        method: 'POST',
        body: { sequence: 1 },
        file: {
          path,
          name: 'segment.tgz.aes256gcm',
          contentType: 'application/octet-stream',
        },
      },
      'Bearer token'
    )

    expect(request.headers).toEqual({ authorization: 'Bearer token' })
    expect(request.body).toBeInstanceOf(FormData)
    const form = request.body as FormData
    expect(form.get('metadata')).toBe('{"sequence":1}')
    expect(await (form.get('file') as File).text()).toBe('encrypted transcript')
  })

  test('streams authenticated backend downloads to a local file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-sync-download-'))
    const path = join(directory, 'segment.enc')

    const body = await readWeworkSyncResponse(
      new Response('encrypted transcript', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
      path,
      Buffer.byteLength('encrypted transcript')
    )

    expect(body).toEqual({ path })
    expect(await readFile(path, 'utf8')).toBe('encrypted transcript')
  })

  test('rejects backend downloads that exceed their declared size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-sync-download-'))
    const path = join(directory, 'segment.enc')

    await expect(readWeworkSyncResponse(new Response('oversized'), path, 4)).rejects.toThrow(
      'exceeds its declared size'
    )
  })
})
