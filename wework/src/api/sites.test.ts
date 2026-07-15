import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSitesApi } from './sites'

describe('createSitesApi', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  test('lists sites for the required username without forwarding Wegent auth', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
    })

    const api = createSitesApi('http://127.0.0.1:8765')
    await api.listSites({ username: 'alice@example.com', q: '产品 站点', offset: 0, limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/v1/sites?username=alice%40example.com&q=%E4%BA%A7%E5%93%81+%E7%AB%99%E7%82%B9&offset=0&limit=20',
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    )
  })

  test('rejects a blank username before making a request', async () => {
    const api = createSitesApi('http://127.0.0.1:8765')

    await expect(api.listSites({ username: '  ', q: '', offset: 0, limit: 20 })).rejects.toThrow(
      'username is required'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('publishes a site using its encoded unique site id', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        siteid: 'site/1',
        publish_status: 'published',
        external_url: 'https://site-1.example.com',
      }),
    })

    const api = createSitesApi('http://127.0.0.1:8765/')
    const site = await api.publishSite('site/1')

    expect(site.external_url).toBe('https://site-1.example.com')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/api/v1/sites/site%2F1/publish', {
      method: 'POST',
      body: undefined,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})
