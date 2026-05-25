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
})
