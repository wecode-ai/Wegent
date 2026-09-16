import { act, renderHook, waitFor } from '@testing-library/react'
import { useManagedTeams } from '@/features/settings/hooks/useManagedTeams'
import { fetchManagedTeamsPage } from '@/features/settings/services/teams'
import type { Team } from '@/types/api'

jest.mock('@/features/settings/services/teams', () => ({ fetchManagedTeamsPage: jest.fn() }))
const fetchPage = jest.mocked(fetchManagedTeamsPage)
const items = Array.from({ length: 205 }, (_, id) => ({ id, name: `agent-${id}` }) as Team)
function page(
  start: number,
  end: number,
  next: { page: number } | { cursor: string } | null = null
) {
  return {
    items: items.slice(start, end),
    next,
  }
}
const options = { userId: 1, scope: 'all' as const, keyword: '' }

beforeEach(() => fetchPage.mockReset())

it('loads one page, coalesces repeated load-more events, and searches locally only after completion', async () => {
  fetchPage
    .mockResolvedValueOnce(page(0, 100, { page: 2 }))
    .mockResolvedValueOnce(page(100, 200, { page: 3 }))
    .mockResolvedValueOnce(page(200, 205))
  const { result, rerender } = renderHook(
    ({ keyword }) => useManagedTeams({ ...options, keyword }),
    { initialProps: { keyword: '' } }
  )
  await waitFor(() => expect(result.current.teams).toHaveLength(100))
  expect(fetchPage).toHaveBeenCalledTimes(1)
  expect(result.current.hasMore).toBe(true)
  await act(async () => {
    await Promise.all([result.current.loadMore(), result.current.loadMore()])
  })
  expect(result.current.teams).toHaveLength(200)
  expect(fetchPage).toHaveBeenCalledTimes(2)
  await act(async () => {
    await result.current.loadMore()
  })
  expect(result.current.teams).toHaveLength(205)
  expect(result.current.hasMore).toBe(false)
  rerender({ keyword: 'agent-204' })
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(fetchPage).toHaveBeenCalledTimes(3)
})

it('pages search results separately and restores the unfinished browsing page when cleared', async () => {
  fetchPage
    .mockResolvedValueOnce(page(0, 100, { page: 2 }))
    .mockResolvedValueOnce(page(200, 203, { cursor: 'search-2' }))
    .mockResolvedValueOnce(page(203, 205))
    .mockResolvedValueOnce(page(100, 200, { page: 3 }))
  const { result, rerender } = renderHook(
    ({ keyword }) => useManagedTeams({ ...options, keyword }),
    { initialProps: { keyword: '' } }
  )
  await waitFor(() => expect(result.current.teams).toHaveLength(100))
  rerender({ keyword: 'older' })
  await waitFor(() => expect(result.current.teams).toHaveLength(3))
  expect(fetchPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ keyword: 'older' }),
    expect.any(AbortSignal)
  )
  await act(async () => {
    await result.current.loadMore()
  })
  expect(result.current.teams).toHaveLength(5)
  expect(fetchPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ keyword: 'older', cursor: 'search-2' }),
    expect.any(AbortSignal)
  )
  rerender({ keyword: '' })
  await waitFor(() => expect(result.current.teams).toHaveLength(100))
  expect(fetchPage).toHaveBeenCalledTimes(3)
  await act(async () => {
    await result.current.loadMore()
  })
  expect(fetchPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ keyword: '', page: 2 }),
    expect.any(AbortSignal)
  )
})

it('preserves loaded cards after a later-page failure and retries only on request', async () => {
  fetchPage
    .mockResolvedValueOnce(page(0, 100, { page: 2 }))
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValueOnce(page(100, 200, { page: 3 }))
  const { result } = renderHook(() => useManagedTeams(options))
  await waitFor(() => expect(result.current.teams).toHaveLength(100))
  await act(async () => {
    await result.current.loadMore()
  })
  expect(result.current.teams).toHaveLength(100)
  expect(result.current.error?.message).toBe('failed')
  expect(fetchPage).toHaveBeenCalledTimes(2)
  await act(async () => {
    await result.current.retry()
  })
  expect(result.current.teams).toHaveLength(200)
  expect(result.current.error).toBeNull()
})

it('ignores an old search response after the keyword changes', async () => {
  let resolveOld!: (value: ReturnType<typeof page>) => void
  fetchPage
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    .mockResolvedValueOnce(page(200, 201))
  const { result, rerender } = renderHook(
    ({ keyword }) => useManagedTeams({ ...options, keyword }),
    { initialProps: { keyword: 'old' } }
  )
  const signal = fetchPage.mock.calls[0][1]!
  rerender({ keyword: 'new' })
  await waitFor(() => expect(result.current.teams[0]?.id).toBe(200))
  expect(signal.aborted).toBe(true)
  await act(async () => resolveOld(page(0, 100, { cursor: 'old-next' })))
  expect(result.current.teams.map(team => team.id)).toEqual([200])
  expect(result.current.hasMore).toBe(false)
})

it('does not load for a creation-only view or an empty group selection', async () => {
  const { rerender } = renderHook(
    ({ enabled, groupNames }) =>
      useManagedTeams({ ...options, scope: 'group', enabled, groupNames }),
    { initialProps: { enabled: false, groupNames: [] as string[] } }
  )
  await act(async () => {})
  expect(fetchPage).not.toHaveBeenCalled()
  rerender({ enabled: true, groupNames: [] })
  await act(async () => {})
  expect(fetchPage).not.toHaveBeenCalled()
})
