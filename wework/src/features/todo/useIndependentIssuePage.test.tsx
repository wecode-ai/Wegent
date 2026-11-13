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
