import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSitesApi } from './sites'

describe('createSitesApi', () => {
  const fetchMock = vi.fn()
  const storage = new Map<string, string>()

  beforeEach(() => {
    fetchMock.mockReset()
    storage.clear()
    storage.set('auth_token', 'wegent-secret')
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('discovers enabled application types and their capabilities', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            app_type: 'web',
            enabled: true,
            order: 10,
            capabilities: ['create', 'publish', 'delete'],
          },
        ],
      }),
    })

    const api = createSitesApi('/api')
    await expect(api.listApplicationTypes()).resolves.toEqual({
      items: [
        {
          app_type: 'web',
          enabled: true,
          order: 10,
          capabilities: ['create', 'publish', 'delete'],
        },
      ],
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/sites/app-types', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })

  test('lists sites through Wegent Backend with the current auth token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
    })

    const api = createSitesApi('/api')
    await api.listSites({ appType: 'web', q: '产品 站点', offset: 0, limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sites?q=%E4%BA%A7%E5%93%81+%E7%AB%99%E7%82%B9&app_type=web&offset=0&limit=20',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wegent-secret',
        },
      }
    )
  })

  test('uses the authenticated cloud connection token instead of the local auth token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [], total: 0, offset: 0, limit: 20 }),
    })

    const api = createSitesApi('http://127.0.0.1:9100/api', {
      getToken: () => 'cloud-secret',
      redirectOnUnauthorized: false,
    })
    await api.listSites({ appType: 'miniapp', offset: 0, limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/api/sites?app_type=miniapp&offset=0&limit=20',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer cloud-secret' }),
      })
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
    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site%2F1/publish', {
      method: 'POST',
      body: undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })

  test('updates a site network scope through Wegent Backend', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        siteid: 'site/1',
        network: 'inner',
        publish_status: 'unpublished',
        external_url: null,
      }),
    })

    const api = createSitesApi('/api/')
    const site = await api.updateSiteNetwork('site/1', 'inner')

    expect(site.network).toBe('inner')
    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site%2F1/network', {
      method: 'PUT',
      body: JSON.stringify({ network: 'inner' }),
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

    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site%2F1', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })
})
