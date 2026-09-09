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
            capabilities: ['create', 'publish', 'edit', 'delete', 'configure_environment'],
            create: {
              plugin_name: 'wegent-sites',
              marketplace_name: 'wegent',
            },
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
          capabilities: ['create', 'publish', 'edit', 'delete', 'configure_environment'],
          create: {
            plugin_name: 'wegent-sites',
            marketplace_name: 'wegent',
          },
        },
      ],
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/sites/app-types', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
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
          'X-Request-ID': expect.stringMatching(/^wework-http-/),
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
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
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
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('updates editable site metadata through Wegent Backend', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        siteid: 'site/1',
        name: 'Docs Site',
        custom_domain_prefix: 'docs',
      }),
    })

    const api = createSitesApi('/api/')
    const site = await api.updateSite('site/1', {
      title: 'Docs Site',
      customDomainPrefix: 'docs',
    })

    expect(site.name).toBe('Docs Site')
    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site%2F1', {
      method: 'PATCH',
      body: JSON.stringify({
        title: 'Docs Site',
        custom_domain_prefix: 'docs',
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('deletes a site using its encoded unique site id', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })

    const api = createSitesApi('/api/')
    await api.deleteSite('site/1')

    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site%2F1', {
      method: 'DELETE',
      body: undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('loads the latest environment snapshot through Wegent Backend', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        revision_id: 'env-1',
        project_id: 'site/1',
        revision_number: 1,
        items: [],
      }),
    })

    const api = createSitesApi('/api/')
    await expect(api.getEnvironmentVariables('site/1')).resolves.toMatchObject({
      revision_id: 'env-1',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site%2F1/environment-variables', {
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
    })
  })

  test('atomically saves environment variables with an idempotency key', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'env-2',
        project_id: 'site/1',
        revision_number: 2,
        variables: [],
        created_by: 'testuser',
        created_at: '2026-09-02T08:00:00Z',
      }),
    })
    const input = {
      expected_revision_id: 'env-1',
      operations: [{ op: 'remove' as const, key: 'OLD_KEY' }],
    }

    const api = createSitesApi('/api/')
    await api.patchEnvironmentVariables('site/1', input, 'site-environment-12345678')

    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site%2F1/environment-variables', {
      method: 'PATCH',
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wegent-secret',
        'Idempotency-Key': 'site-environment-12345678',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('lists, adds, and removes collaborators through Wegent Backend', async () => {
    const collaborator = {
      subject: 'member+test',
      added_by: 'owner',
      created_at: '2026-09-03T08:00:00Z',
    }
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [collaborator] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => collaborator,
      })
      .mockResolvedValueOnce({ ok: true, status: 204 })

    const api = createSitesApi('/api/')
    await expect(api.listCollaborators('site/1')).resolves.toEqual({ items: [collaborator] })
    await expect(
      api.addCollaborator('site/1', 'member+test', 'collaborator-add-12345678')
    ).resolves.toEqual(collaborator)
    await api.removeCollaborator('site/1', 'member+test')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/sites/site%2F1/collaborators', {
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/sites/site%2F1/collaborators', {
      method: 'POST',
      body: JSON.stringify({ subject: 'member+test' }),
      headers: expect.objectContaining({
        Authorization: 'Bearer wegent-secret',
        'Idempotency-Key': 'collaborator-add-12345678',
      }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/sites/site%2F1/collaborators/member%2Btest',
      {
        method: 'DELETE',
        body: undefined,
        headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
      }
    )
  })

  test('loads and updates internal access through Wegent Backend', async () => {
    const existing = {
      id: 'policy-1',
      project_id: 'site/1',
      target: 'inner',
      audience: 'owner',
      subjects: [],
      revision_number: 2,
      created_by: 'owner',
      created_at: '2026-09-08T08:00:00Z',
    }
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => existing })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ...existing,
          audience: 'custom',
          subjects: ['member-a'],
          revision_number: 3,
        }),
      })

    const api = createSitesApi('/api/')
    await expect(api.getSiteAccess('site/1')).resolves.toEqual(existing)
    await api.updateSiteAccess(
      'site/1',
      { audience: 'custom', subjects: ['member-a'] },
      'site-access-12345678'
    )

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/sites/site%2F1/access', {
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer wegent-secret' }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/sites/site%2F1/access', {
      method: 'PUT',
      body: JSON.stringify({ audience: 'custom', subjects: ['member-a'] }),
      headers: expect.objectContaining({
        Authorization: 'Bearer wegent-secret',
        'Idempotency-Key': 'site-access-12345678',
      }),
    })
  })
})
