import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSitesApi, createUnavailableSitesApi } from './sites'

describe('createSitesApi', () => {
  const fetchMock = vi.fn()
  const siteProject = {
    id: 'prj/site-1',
    network: 'inner',
    title: '产品站点',
    url: 'http://site-1.internal',
    snapshot: 'https://snapshot.example.com/site-1.png',
    created_at: '2026-07-17T08:00:00Z',
  } as const

  beforeEach(() => {
    fetchMock.mockReset()
    localStorage.setItem('auth_token', 'wegent-secret')
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  test('lists sites through Wegent Backend with query, cursor, and the current auth token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [siteProject], next_cursor: 'prj/next' }),
    })

    const api = createSitesApi('/api')
    const response = await api.listSites({
      q: '产品 站点',
      cursor: 'prj/current',
      limit: 20,
    })

    expect(response).toEqual({ items: [siteProject], next_cursor: 'prj/next' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/sites?q=%E4%BA%A7%E5%93%81+%E7%AB%99%E7%82%B9&cursor=prj%2Fcurrent&limit=20',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wegent-secret',
        },
      }
    )
  })

  test('omits blank queries and null cursors while using the cloud connection token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [], next_cursor: null }),
    })

    const api = createSitesApi('http://127.0.0.1:9100/api', {
      getToken: () => 'cloud-secret',
      redirectOnUnauthorized: false,
    })
    await api.listSites({ q: '   ', cursor: null, limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9100/api/v1/sites?limit=20', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cloud-secret',
      },
    })
  })

  test('publishes a project using its encoded opaque id and returns the outer project', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ...siteProject,
        network: 'outer',
        url: 'https://site-1.example.com',
      }),
    })

    const api = createSitesApi('/api/')
    const site = await api.publishSite('prj/site-1')

    expect(site.network).toBe('outer')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/prj%2Fsite-1/publish', {
      method: 'POST',
      body: undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })

  test('renames a project using its encoded opaque id and title body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...siteProject, title: '新的站点标题' }),
    })

    const api = createSitesApi('/api/')
    const site = await api.renameSite('prj/site-1', '新的站点标题')

    expect(site.title).toBe('新的站点标题')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/prj%2Fsite-1/rename', {
      method: 'POST',
      body: JSON.stringify({ title: '新的站点标题' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })

  test('deletes a project using its encoded opaque id and accepts a 204 response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })

    const api = createSitesApi('/api/')
    await api.deleteSite('prj/site-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sites/prj%2Fsite-1', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
      },
    })
  })

  test('exposes rename as unavailable when Sites is unavailable', async () => {
    const api = createUnavailableSitesApi()

    await expect(api.renameSite('prj/site-1', '新的站点标题')).rejects.toMatchObject({
      status: 503,
      errorCode: 'sites_not_available',
    })
  })
})
