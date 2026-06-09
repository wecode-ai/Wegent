import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError, createHttpClient } from './http'

describe('createHttpClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    localStorage.clear()
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
})
