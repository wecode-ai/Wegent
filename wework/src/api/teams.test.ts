import { describe, expect, it, vi } from 'vitest'
import type { HttpClient, HttpRequestOptions } from './http'
import { createTeamApi } from './teams'

function createClient(get: HttpClient['get']): HttpClient {
  return {
    get,
    getBlob: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
}

describe('team catalog pagination', () => {
  it('returns all 205 teams to desktop selectors', async () => {
    const items = Array.from({ length: 205 }, (_, id) => ({ id, name: `team-${id}` }))
    const get = vi
      .fn<HttpClient['get']>()
      .mockResolvedValueOnce({ total: 205, items: items.slice(0, 100) })
      .mockResolvedValueOnce({ total: 205, items: items.slice(100, 200) })
      .mockResolvedValueOnce({ total: 205, items: items.slice(200) })

    await expect(createTeamApi(createClient(get)).listTeams()).resolves.toEqual(items)
    expect(get.mock.calls).toEqual([
      ['/teams?page=1&limit=100'],
      ['/teams?page=2&limit=100'],
      ['/teams?page=3&limit=100'],
    ])
  })

  it('passes cancellation to every page and rejects instead of returning a partial list', async () => {
    const controller = new AbortController()
    const error = new DOMException('Aborted', 'AbortError')
    const get = vi
      .fn<HttpClient['get']>()
      .mockResolvedValueOnce({
        total: 205,
        items: Array.from({ length: 100 }, (_, id) => ({ id })),
      })
      .mockImplementationOnce(async (_endpoint: string, options?: HttpRequestOptions) => {
        controller.abort()
        expect(options?.signal?.aborted).toBe(true)
        throw error
      })

    await expect(
      createTeamApi(createClient(get)).listTeams({ signal: controller.signal })
    ).rejects.toBe(error)
    expect(get.mock.calls).toEqual([
      ['/teams?page=1&limit=100', { signal: controller.signal }],
      ['/teams?page=2&limit=100', { signal: controller.signal }],
    ])
  })
})
