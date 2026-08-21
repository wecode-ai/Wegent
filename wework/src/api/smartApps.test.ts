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

  test('uploads a package before completing the two-phase submission', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        submissionId: 9,
        smartAppId: 3,
        uploadUrl: 'https://uploads.example/app.zip',
        expiresAt: '2026-08-20T00:10:00Z',
      })
      .mockResolvedValueOnce({ submission: { id: 9 }, item: { id: 3 } })
    const upload = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))
    const api = createSmartAppsApi({ post } as unknown as HttpClient)
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
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        extensions: { 'io.wegent.test': { owner: 'api-test' } },
        releaseExtensions: { 'io.wegent.build': { pipeline: 'test' } },
      })
    )
    expect(upload).toHaveBeenCalledWith(
      'https://uploads.example/app.zip',
      expect.objectContaining({ method: 'PUT', body: file })
    )
    expect(post).toHaveBeenNthCalledWith(2, '/smart-apps/submissions/9/complete')
  })
})
