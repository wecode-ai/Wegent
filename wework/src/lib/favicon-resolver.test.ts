import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

async function loadResolver() {
  return import('./favicon-resolver')
}

let imageShouldFail = false
class MockImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(value: string) {
    if (imageShouldFail) this.onerror?.()
    else this.onload?.()
  }
}

describe('favicon-resolver', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    imageShouldFail = false
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

  test('does not cache network failures so favicons recover once the backend is reachable', async () => {
    const { resolveFavicon } = await loadResolver()
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://foo.example/x',
        favicon: 'https://foo.example/icon.png',
        success: true,
      }),
    })

    await expect(resolveFavicon('https://foo.example/x')).resolves.toBeUndefined()
    await expect(resolveFavicon('https://foo.example/y')).resolves.toBe(
      'https://foo.example/icon.png'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

  test('builds the offline favicon placeholder from a URL', async () => {
    const { faviconPlaceholderUrl } = await loadResolver()
    expect(faviconPlaceholderUrl('https://example.com/docs')).toBe(
      'https://example.com/favicon.ico'
    )
    expect(faviconPlaceholderUrl('http://localhost:3000/x')).toBe(
      'http://localhost:3000/favicon.ico'
    )
    expect(faviconPlaceholderUrl('wegent-sites-project://prj_01')).toBeUndefined()
    expect(faviconPlaceholderUrl('not a url')).toBeUndefined()
  })

  test('shows the placeholder icon before the backend favicon', async () => {
    const { resolveAndProbeIcon, resolveFavicon } = await loadResolver()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://example.com/x',
        favicon: 'https://example.com/icon.png',
        success: true,
      }),
    })
    vi.stubGlobal('Image', MockImage)

    const shown: string[] = []
    resolveAndProbeIcon(
      'https://example.com/docs',
      resolveFavicon('https://example.com/docs'),
      url => shown.push(url),
      () => false
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(shown).toEqual(['https://example.com/favicon.ico', 'https://example.com/icon.png'])
  })

  test('evicts a cached favicon that fails to render so the next resolve retries', async () => {
    const { resolveAndProbeIcon, resolveFavicon } = await loadResolver()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://example.com/a',
        favicon: 'https://example.com/icon.png',
        success: true,
      }),
    })
    vi.stubGlobal('Image', MockImage)
    imageShouldFail = true

    resolveAndProbeIcon(
      'https://example.com/a',
      resolveFavicon('https://example.com/a'),
      () => {},
      () => false
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    // The failed probe evicted the cache, so resolving again refetches and
    // picks up a loadable favicon instead of the broken cached URL.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://example.com/b',
        favicon: 'https://example.com/icon2.png',
        success: true,
      }),
    })
    await expect(resolveFavicon('https://example.com/b')).resolves.toBe(
      'https://example.com/icon2.png'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
