import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

async function loadResolver() {
  return import('./favicon-resolver')
}

describe('favicon-resolver', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    localStorage.clear()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('returns the real favicon from the backend', async () => {
    const { resolveFavicon } = await loadResolver()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://example.com/page',
        favicon: 'https://example.com/icon.png',
        success: true,
      }),
    })

    const favicon = await resolveFavicon('https://example.com/page')
    expect(favicon).toBe('https://example.com/icon.png')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/utils/url-metadata?url='),
      expect.anything()
    )
  })

  test('caches the favicon per domain', async () => {
    const { resolveFavicon } = await loadResolver()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://example.com/a',
        favicon: 'https://example.com/icon.png',
        success: true,
      }),
    })

    await resolveFavicon('https://example.com/a')
    await resolveFavicon('https://example.com/b')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('returns undefined and caches the failure when the backend call fails', async () => {
    const { resolveFavicon } = await loadResolver()
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    await expect(resolveFavicon('https://foo.example/x')).resolves.toBeUndefined()
    await resolveFavicon('https://foo.example/y')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('caches a success:false response without retrying within the TTL', async () => {
    const { resolveFavicon } = await loadResolver()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://blocked.example/x', favicon: null, success: false }),
    })

    await expect(resolveFavicon('https://blocked.example/x')).resolves.toBeUndefined()
    await resolveFavicon('https://blocked.example/y')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('shares one cache entry across www and bare domains', async () => {
    const { resolveFavicon } = await loadResolver()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://www.example.com/a',
        favicon: 'https://example.com/icon.png',
        success: true,
      }),
    })

    await resolveFavicon('https://www.example.com/a')
    await resolveFavicon('https://example.com/b')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('returns undefined for invalid URLs', async () => {
    const { resolveFavicon } = await loadResolver()
    await expect(resolveFavicon('not a url')).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
