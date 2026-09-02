import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createDeliveryApi } from './deliveries'
import { createDeviceApi } from './devices'
import { ApiError, createHttpClient } from './http'

describe('createHttpClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('adds auth token and parses json responses', async () => {
    localStorage.setItem('auth_token', 'token-1')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })

    const client = createHttpClient({ baseUrl: 'http://backend/api' })
    const result = await client.get<{ ok: boolean }>('/projects')

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('http://backend/api/projects', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-1',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('sends patch requests through the configured authenticated backend', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ version: 2 }),
    })

    const client = createHttpClient({
      baseUrl: 'https://cloud.example.com/api',
      getToken: () => 'cloud-token',
    })
    const result = await client.patch<{ version: number }>('/v1/loop-items/WEG-1', {
      version: 1,
      status: 'in_progress',
    })

    expect(result).toEqual({ version: 2 })
    expect(fetchMock).toHaveBeenCalledWith('https://cloud.example.com/api/v1/loop-items/WEG-1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cloud-token',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
      body: JSON.stringify({ version: 1, status: 'in_progress' }),
    })
  })

  test('forwards idempotency headers on mutation requests', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 82 }),
    })

    const client = createHttpClient({ baseUrl: '/api', getToken: () => 'cloud-token' })
    await client.post(
      '/plugins/publication-requests',
      { requestedVersion: '1.2.0' },
      { headers: { 'Idempotency-Key': 'publication-create-82' } }
    )

    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/publication-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cloud-token',
        'Idempotency-Key': 'publication-create-82',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
      body: JSON.stringify({ requestedVersion: '1.2.0' }),
    })
  })

  test('uses one cloud connection for devices and cloud projects', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [], total: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      })
    const client = createHttpClient({
      baseUrl: 'http://localhost:8000/api',
      getToken: () => 'cloud-token',
    })

    await createDeviceApi(client).listDevices()
    await createDeliveryApi(client).listCloudProjects()

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:8000/api/devices', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cloud-token',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:8000/api/v1/cloud-projects', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cloud-token',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('deduplicates concurrent get requests for the same endpoint and token', async () => {
    localStorage.setItem('auth_token', 'token-1')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [1, 2, 3] }),
    })

    const client = createHttpClient({ baseUrl: '/api' })
    const [firstResult, secondResult] = await Promise.all([
      client.get<{ items: number[] }>('/projects'),
      client.get<{ items: number[] }>('/projects'),
    ])

    expect(firstResult).toEqual({ items: [1, 2, 3] })
    expect(secondResult).toEqual({ items: [1, 2, 3] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-1',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('clears get dedupe after the request settles', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ count: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ count: 2 }),
      })

    const client = createHttpClient({ baseUrl: '/api' })

    await expect(client.get<{ count: number }>('/devices')).resolves.toEqual({ count: 1 })
    await expect(client.get<{ count: number }>('/devices')).resolves.toEqual({ count: 2 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('logs a correlated diagnostic when a request remains pending', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let resolveResponse: ((response: Response) => void) | undefined
    fetchMock.mockReturnValueOnce(
      new Promise<Response>(resolve => {
        resolveResponse = resolve
      })
    )

    try {
      const client = createHttpClient({ baseUrl: 'https://cloud.example.com/api' })
      const request = client.get('/devices')

      await vi.advanceTimersByTimeAsync(5000)

      expect(warn).toHaveBeenCalledWith(
        '[Wework] HTTP GET /devices is still pending after 5000ms.',
        expect.objectContaining({
          request_id: expect.stringMatching(/^wework-http-/),
          phase: 'waiting_for_response',
          endpoint: '/devices',
          transport: 'fetch',
        })
      )

      resolveResponse?.({
        ok: true,
        status: 200,
        headers: new Headers({ 'X-Request-ID': 'backend-request-1' }),
        json: async () => ({ items: [] }),
      } as Response)
      await request

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('completed slowly'),
        expect.objectContaining({
          backend_request_id: 'backend-request-1',
          phase: 'response_received',
          status: 200,
        })
      )
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  test('logs transport error details without logging the authorization token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      fetchMock.mockRejectedValueOnce(new TypeError('Load failed'))
      const client = createHttpClient({
        baseUrl: 'https://cloud.example.com/api',
        getToken: () => 'secret-cloud-token',
      })

      await expect(client.get('/devices')).rejects.toThrow('Load failed')

      const serializedCalls = JSON.stringify(warn.mock.calls)
      expect(serializedCalls).toContain('Load failed')
      expect(serializedCalls).toContain('"phase":"transport"')
      expect(serializedCalls).not.toContain('secret-cloud-token')
    } finally {
      warn.mockRestore()
    }
  })

  test('uses the diagnostic lifecycle for blob requests', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: new Headers({ 'X-Request-ID': 'backend-blob-request' }),
      text: async () => 'blob service unavailable',
    })

    try {
      const client = createHttpClient({
        baseUrl: 'https://cloud.example.com/api',
        getToken: () => 'secret-cloud-token',
      })

      await expect(client.getBlob('/attachments/1')).rejects.toMatchObject({
        status: 502,
        message: 'blob service unavailable',
      })

      expect(warn).toHaveBeenCalledWith(
        '[Wework] HTTP GET /attachments/1 returned 502.',
        expect.objectContaining({
          phase: 'http_error',
          backend_request_id: 'backend-blob-request',
        })
      )
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-cloud-token')
    } finally {
      warn.mockRestore()
    }
  })

  test('restores blob type from response headers', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'image/png' }),
      blob: async () => new Blob(['image']),
    })
    const client = createHttpClient({ baseUrl: 'https://cloud.example.com/api' })

    const blob = await client.getBlob('/attachments/1/download')

    expect(blob.type).toBe('image/png')
    await expect(blob.text()).resolves.toBe('image')
  })

  test('throws ApiError with parsed detail message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ detail: 'backend exploded' }),
    })

    const client = createHttpClient({ baseUrl: '/api' })

    await expect(client.get('/tasks')).rejects.toMatchObject<ApiError>({
      message: 'backend exploded',
      status: 500,
    })
  })

  test('preserves structured error details and codes', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          detail: {
            code: 'TURN_FILE_CHANGES_CONFLICT',
            message: 'Patch does not apply',
            file_changes: { status: 'conflicted' },
          },
        }),
    })

    const client = createHttpClient({ baseUrl: '/api' })

    await expect(client.post('/subtasks/9/file-changes/revert')).rejects.toMatchObject({
      message: 'Patch does not apply',
      status: 409,
      errorCode: 'TURN_FILE_CHANGES_CONFLICT',
      detail: {
        file_changes: { status: 'conflicted' },
      },
    })
  })

  test('parses nested external service errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () =>
        JSON.stringify({
          error: {
            code: 'site_publish_failed',
            message: 'CDN failed',
          },
        }),
    })

    const client = createHttpClient({ baseUrl: 'https://sites.example.com' })

    await expect(client.post('/api/sites/site-1/publish')).rejects.toMatchObject<ApiError>({
      message: 'CDN failed',
      status: 502,
      errorCode: 'site_publish_failed',
      detail: {
        code: 'site_publish_failed',
        message: 'CDN failed',
      },
    })
  })

  test('posts FormData without forcing a json content type', async () => {
    localStorage.setItem('auth_token', 'token-1')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })

    const formData = new FormData()
    formData.append('file', new File(['zip'], 'plugin.zip'))
    const client = createHttpClient({ baseUrl: '/api' })

    await client.post('/plugins/upload', formData)

    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/upload', {
      method: 'POST',
      body: formData,
      headers: {
        Authorization: 'Bearer token-1',
        'X-Request-ID': expect.stringMatching(/^wework-http-/),
      },
    })
  })

  test('clears token and redirects to login on 401', async () => {
    localStorage.setItem('auth_token', 'token-1')
    window.history.pushState({}, '', '/current?x=1')
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: 'Unauthorized' }),
    })

    const client = createHttpClient({ baseUrl: '/api' })

    await expect(client.get('/users/me')).rejects.toMatchObject<ApiError>({
      status: 401,
    })
    expect(localStorage.getItem('auth_token')).toBeNull()
    expect(sessionStorage.getItem('postLoginRedirectPath')).toBe('/current?x=1')
    expect(window.location.pathname).toBe('/login')
  })

  test('can disable login redirects for anonymous 401 handshakes', async () => {
    localStorage.setItem('auth_token', 'token-1')
    window.history.pushState({}, '', '/login')
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: 'Unauthorized' }),
    })

    const client = createHttpClient({ baseUrl: '/api' })

    await expect(
      client.get('/users/me', { redirectOnUnauthorized: false })
    ).rejects.toMatchObject<ApiError>({
      status: 401,
    })
    expect(localStorage.getItem('auth_token')).toBe('token-1')
    expect(sessionStorage.getItem('postLoginRedirectPath')).toBeNull()
    expect(window.location.pathname).toBe('/login')
  })
})
