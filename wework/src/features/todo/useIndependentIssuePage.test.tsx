import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  IndependentIssue,
  IndependentIssuePage,
  PersonalIssueScope,
} from '@/api/personalIssues'
import { useIndependentIssuePage } from './useIndependentIssuePage'

const context = vi.hoisted(() => ({ userId: 7, revision: 0, api: { list: vi.fn() } }))
vi.mock('./independentIssuesContext', () => ({ useIndependentIssues: () => context }))
afterEach(() => {
  cleanup()
  context.api.list.mockReset()
})

it('retains same-scope results on refresh failure and hides them in a different scope', async () => {
  const item = { id: 'private-issue' } as IndependentIssue
  context.api.list
    .mockResolvedValueOnce({ items: [item], next_cursor: null })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [], next_cursor: null })
  const { result, rerender } = renderHook(
    ({ scope }) => useIndependentIssuePage(scope, false, true),
    { initialProps: { scope: 'created' as PersonalIssueScope } }
  )
  await waitFor(() => expect(result.current.items).toEqual([item]))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.error).toBe('offline'))
  expect(result.current.items).toEqual([item])
  rerender({ scope: 'assigned' })
  expect(result.current.items).toEqual([])
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(context.api.list.mock.lastCall?.[0]).toBe('assigned')
})

it('does not publish a late response from the previous scope', async () => {
  let resolve!: (page: IndependentIssuePage) => void
  context.api.list
    .mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    .mockResolvedValueOnce({ items: [{ id: 'assigned' }], next_cursor: null })
  const { result, rerender } = renderHook(
    ({ scope }) => useIndependentIssuePage(scope, false, true),
    { initialProps: { scope: 'created' as PersonalIssueScope } }
  )
  rerender({ scope: 'assigned' })
  await waitFor(() => expect(result.current.items.map(issue => issue.id)).toEqual(['assigned']))
  await act(async () =>
    resolve({ items: [{ id: 'created' } as IndependentIssue], next_cursor: null })
  )
  expect(result.current.items.map(issue => issue.id)).toEqual(['assigned'])
})

it('does not request an inactive list', () => {
  renderHook(() => useIndependentIssuePage('participating', false, false))
  expect(context.api.list).not.toHaveBeenCalled()
})

it('deduplicates pagination and rejects a page overtaken by a refresh', async () => {
  let finishPage!: (page: IndependentIssuePage) => void
  context.api.list
    .mockResolvedValueOnce({ items: [{ id: 'first' }], next_cursor: 'cursor-1' })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishPage = resolve
        })
    )
    .mockResolvedValueOnce({ items: [{ id: 'fresh' }], next_cursor: 'cursor-2' })
    .mockResolvedValueOnce({
      items: [{ id: 'fresh', title: 'updated' }, { id: 'next' }],
      next_cursor: null,
    })
  const { result } = renderHook(() => useIndependentIssuePage('created', false, true))
  await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual(['first']))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.loadMore()
    void result.current.loadMore()
  })
  expect(context.api.list).toHaveBeenCalledTimes(2)
  expect(context.api.list.mock.lastCall?.[2]).toBe('cursor-1')
  await act(() => result.current.reload())
  await act(async () => {
    finishPage({ items: [{ id: 'stale' } as IndependentIssue], next_cursor: null })
    await pending
  })
  expect(result.current.items.map(item => item.id)).toEqual(['fresh'])
  await act(() => result.current.loadMore())
  expect(context.api.list.mock.lastCall?.[2]).toBe('cursor-2')
  expect(result.current.items.map(item => item.id)).toEqual(['fresh', 'next'])
  expect(result.current.items[0].title).toBe('updated')
  expect(result.current.hasMore).toBe(false)
})

it('suspends hidden lists, revalidates on activation and focus, and follows context revisions', async () => {
  context.api.list.mockResolvedValue({ items: [{ id: 'cached' }], next_cursor: null })
  const { result, rerender, unmount } = renderHook(
    ({ active }) => useIndependentIssuePage('assigned', false, active),
    { initialProps: { active: true } }
  )
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  rerender({ active: false })
  act(() => {
    window.dispatchEvent(new Event('focus'))
    void result.current.reload()
  })
  expect(context.api.list).toHaveBeenCalledTimes(1)
  expect(result.current.items[0].id).toBe('cached')
  rerender({ active: true })
  await waitFor(() => expect(context.api.list).toHaveBeenCalledTimes(2))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(context.api.list).toHaveBeenCalledTimes(3)
  context.revision++
  rerender({ active: true })
  await waitFor(() => expect(context.api.list).toHaveBeenCalledTimes(4))
  unmount()
  window.dispatchEvent(new Event('focus'))
  expect(context.api.list).toHaveBeenCalledTimes(4)
})

it('isolates different owners and rejects detached pagination results', async () => {
  let finish!: (page: IndependentIssuePage) => void
  context.api.list
    .mockResolvedValueOnce({ items: [{ id: 'owner-a' }], next_cursor: 'more' })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ items: [{ id: 'owner-b' }], next_cursor: null })
  const { result, rerender } = renderHook(() => useIndependentIssuePage('created', false, true))
  await waitFor(() => expect(result.current.items[0]?.id).toBe('owner-a'))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.loadMore()
  })
  const previousUser = context.userId
  try {
    context.userId = 9
    rerender()
    expect(result.current.items).toEqual([])
    await waitFor(() => expect(result.current.items[0]?.id).toBe('owner-b'))
    await act(async () => {
      finish({ items: [{ id: 'late-owner-a' } as IndependentIssue], next_cursor: null })
      await pending
    })
    expect(result.current.items.map(item => item.id)).toEqual(['owner-b'])
  } finally {
    context.userId = previousUser
  }
})
