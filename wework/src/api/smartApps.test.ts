import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { createSmartAppsApi } from './smartApps'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createSmartAppsApi', () => {
  test('builds marketplace filters without empty query parameters', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] })
    const api = createSmartAppsApi({ get } as unknown as HttpClient)

    await api.listMarketplace({ q: ' research ', source: 'official', tag: 'data' })

    expect(get).toHaveBeenCalledWith('/smart-apps/marketplace?q=research&source=official&tag=data')
  })

  test('resolves a Backend artifact path against the connected cloud API', async () => {
    const post = vi.fn().mockResolvedValue({
      smartAppId: 3,
      releaseId: 8,
      version: '1.0.0',
      filename: 'research.zip',
      downloadUrl: '/api/smart-apps/marketplace/3/artifact?token=ticket',
      sha256: '0'.repeat(64),
      sizeBytes: 9,
      expiresAt: '2026-08-27T10:00:00Z',
    })
    const api = createSmartAppsApi(
      { post } as unknown as HttpClient,
      'https://api.example.test/api'
    )

    const descriptor = await api.getDownload(3)

    expect(descriptor.downloadUrl).toBe(
      'https://api.example.test/api/smart-apps/marketplace/3/artifact?token=ticket'
    )
  })

  test('uploads a package before completing the two-phase submission', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        submissionId: 9,
        smartAppId: 3,
        uploadUrl: '/api/smart-apps/submissions/9/artifact?token=ticket',
        expiresAt: '2026-08-20T00:10:00Z',
      })
      .mockResolvedValueOnce({ submission: { id: 9 }, item: { id: 3 } })
    const upload = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))
    const api = createSmartAppsApi(
      { post } as unknown as HttpClient,
      'https://api.example.test/api'
    )
    const file = new File([new Uint8Array([1, 2, 3])], 'app.zip', {
      type: 'application/zip',
    })

    await api.publish(file, {
      name: 'research',
      displayName: 'Research',
      version: '1.0.0',
      summary: 'Research',
      descriptionMd: '# Research',
      tags: ['data'],
      iconDataUrl: 'data:image/png;base64,cG5n',
      screenshotDataUrls: [],
      releaseNotes: '',
      extensions: { 'io.wegent.test': { owner: 'api-test' } },
      releaseExtensions: { 'io.wegent.build': { pipeline: 'test' } },
      targets: [{ entityType: 'user', entityId: '2', displayName: 'Alice' }],
    })

    expect(post).toHaveBeenNthCalledWith(
      1,
      '/smart-apps/submissions/init',
      expect.objectContaining({
        filename: 'app.zip',
        sizeBytes: 3,
        sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        extensions: { 'io.wegent.test': { owner: 'api-test' } },
        releaseExtensions: { 'io.wegent.build': { pipeline: 'test' } },
      })
    )
    expect(upload).toHaveBeenCalledWith(
      'https://api.example.test/api/smart-apps/submissions/9/artifact?token=ticket',
      expect.objectContaining({ method: 'PUT', body: file })
    )
    expect(post).toHaveBeenNthCalledWith(2, '/smart-apps/submissions/9/complete')
  })
})
