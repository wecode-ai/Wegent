import { describe, expect, test, vi } from 'vitest'
import {
  fetchOptionalPublishedDescriptor,
  fetchPublishedResource,
  PublishedRuntimeUnavailableError,
} from './published-runtime-fetch.mjs'

describe('fetchOptionalPublishedDescriptor', () => {
  test('falls back to a local build when the release gateway is temporarily unavailable', async () => {
    const log = vi.fn()

    const response = await fetchOptionalPublishedDescriptor('https://example.test/runtime.json', {
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 504 })),
      log,
    })

    expect(response).toBeNull()
    expect(log).toHaveBeenCalledOnce()
  })

  test('treats a missing descriptor as an unpublished runtime', async () => {
    const response = await fetchOptionalPublishedDescriptor('https://example.test/runtime.json', {
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 404 })),
      log: vi.fn(),
    })

    expect(response).toBeNull()
  })

  test('keeps permanent HTTP failures visible', async () => {
    const response = await fetchOptionalPublishedDescriptor('https://example.test/runtime.json', {
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 403 })),
      log: vi.fn(),
    })

    expect(response?.status).toBe(403)
  })
})

describe('fetchPublishedResource', () => {
  test('classifies transport failures as temporary unavailability', async () => {
    await expect(
      fetchPublishedResource(
        'https://example.test/runtime.tar.gz',
        vi.fn().mockRejectedValue(new Error('network unavailable'))
      )
    ).rejects.toBeInstanceOf(PublishedRuntimeUnavailableError)
  })
})
