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

  test('lists sites through Wegent Backend with the current auth token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
    })

    const api = createSitesApi('/api')
    await api.listSites({ q: '产品 站点', offset: 0, limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/sites?q=%E4%BA%A7%E5%93%81+%E7%AB%99%E7%82%B9&offset=0&limit=20',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wegent-secret',
        },
      }
    )
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

    const api = createSitesApi('/api/')
    const site = await api.publishSite('site/1')

    expect(site.external_url).toBe('https://site-1.example.com')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/site%2F1/publish', {
      method: 'POST',
      body: undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })

  test('deletes a site using its encoded unique site id', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })

    const api = createSitesApi('/api/')
    await api.deleteSite('site/1')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/site%2F1', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })
})
