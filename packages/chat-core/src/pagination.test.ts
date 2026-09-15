import { describe, expect, it, vi } from 'vitest'
import { fetchAllPages } from './pagination'

describe('fetchAllPages', () => {
  it.each([0, 99, 100, 200, 205])('loads all %i items without an extra page', async total => {
    const items = Array.from({ length: total }, (_, id) => ({ id }))
    const fetchPage = vi.fn(async (page: number, limit: number) => ({
      total,
      items: items.slice((page - 1) * limit, page * limit),
    }))

    await expect(fetchAllPages(fetchPage)).resolves.toEqual({ total, items })
    expect(fetchPage).toHaveBeenCalledTimes(Math.max(1, Math.ceil(total / 100)))
  })

  it('deduplicates items that move between pages while loading', async () => {
    const items = Array.from({ length: 100 }, (_, id) => ({ id }))
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ total: 101, items })
      .mockResolvedValueOnce({ total: 101, items: [{ id: 99 }, { id: 100 }] })

    const result = await fetchAllPages(fetchPage)

    expect(result.items).toEqual([...items, { id: 100 }])
  })

  it('stops on an empty page if items were removed during loading', async () => {
    const items = Array.from({ length: 100 }, (_, id) => ({ id }))
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ total: 205, items })
      .mockResolvedValueOnce({ total: 205, items: [] })

    await expect(fetchAllPages(fetchPage)).resolves.toEqual({
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

    await expect(fetchAllPages(fetchPage)).rejects.toBe(error)

    fetchPage
      .mockResolvedValueOnce({ total: 101, items })
      .mockResolvedValueOnce({ total: 101, items: [{ id: 100 }] })
    await expect(fetchAllPages(fetchPage)).resolves.toEqual({
      total: 101,
      items: [...items, { id: 100 }],
    })
    expect(fetchPage).toHaveBeenNthCalledWith(3, 1, 100)
  })
})
