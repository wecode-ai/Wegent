import { describe, expect, it, vi } from 'vitest'
import { fetchAllTeams } from './team-list'

describe('fetchAllTeams', () => {
  it.each([0, 99, 100, 200, 205])('loads all %i teams without an extra page', async total => {
    const items = Array.from({ length: total }, (_, id) => ({ id }))
    const fetchPage = vi.fn(async (page: number, limit: number) => ({
      total,
      items: items.slice((page - 1) * limit, page * limit),
    }))

    await expect(fetchAllTeams(fetchPage)).resolves.toEqual({ total, items })
    expect(fetchPage).toHaveBeenCalledTimes(Math.max(1, Math.ceil(total / 100)))
  })

  it('deduplicates teams that move between pages while loading', async () => {
    const items = Array.from({ length: 100 }, (_, id) => ({ id }))
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ total: 101, items })
      .mockResolvedValueOnce({ total: 101, items: [{ id: 99 }, { id: 100 }] })

    const result = await fetchAllTeams(fetchPage)

    expect(result.items).toEqual([...items, { id: 100 }])
  })

  it('stops on an empty page if teams were removed during loading', async () => {
    const items = Array.from({ length: 100 }, (_, id) => ({ id }))
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ total: 205, items })
      .mockResolvedValueOnce({ total: 205, items: [] })

    await expect(fetchAllTeams(fetchPage)).resolves.toEqual({
      total: 205,
      items,
    })
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('rejects a failed later page and can load the full catalog on refresh', async () => {
    const items = Array.from({ length: 100 }, (_, id) => ({ id }))
    const error = new Error('Page unavailable')
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ total: 101, items })
      .mockRejectedValueOnce(error)

    await expect(fetchAllTeams(fetchPage)).rejects.toBe(error)

    fetchPage
      .mockResolvedValueOnce({ total: 101, items })
      .mockResolvedValueOnce({ total: 101, items: [{ id: 100 }] })
    await expect(fetchAllTeams(fetchPage)).resolves.toEqual({
      total: 101,
      items: [...items, { id: 100 }],
    })
    expect(fetchPage).toHaveBeenNthCalledWith(3, 1, 100)
  })
})
