import { describe, expect, test } from 'vitest'

import {
  createWeworkSyncRequestSignal,
  normalizeWeworkSyncApiBaseUrl,
  normalizeWeworkSyncPath,
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
})
