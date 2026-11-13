import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceMyWorkItem } from '@wegent/collaboration'
import { usePersonalHomeIssues } from './usePersonalHomeIssues'

afterEach(cleanup)

it('hides the previous query scope while loading and after a failed scope change', async () => {
  let reject!: (error: Error) => void
  const item = { id: 'participating', cloud_project_id: 'project' } as WorkspaceMyWorkItem
  const page = vi
    .fn()
    .mockResolvedValueOnce({ items: [item], nextCursor: null })
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
  const api = { myWork: { page } } as unknown as SharedWorkspaceApi
  const sources = [api]
  const { result, rerender } = renderHook(
    ({ assigned }) => usePersonalHomeIssues(sources, true, assigned, false, [7]),
    { initialProps: { assigned: false } }
  )
  await waitFor(() => expect(result.current.items).toEqual([item]))
  rerender({ assigned: true })
  expect(result.current.items).toEqual([])
  await waitFor(() => expect(page).toHaveBeenCalledTimes(2))
  await act(async () => reject(new Error('offline')))
  await waitFor(() => expect(result.current.error).toBe(true))
  expect(result.current.items).toEqual([])
})

it('retains valid same-scope results on a refresh failure', async () => {
  const item = { id: 'mine', cloud_project_id: 'project' } as WorkspaceMyWorkItem
  const page = vi
    .fn()
    .mockResolvedValueOnce({ items: [item], nextCursor: null })
    .mockRejectedValueOnce(new Error('offline'))
  const sources = [{ myWork: { page } } as unknown as SharedWorkspaceApi]
  const { result } = renderHook(() => usePersonalHomeIssues(sources, true, true, false, [7]))
  await waitFor(() => expect(result.current.items).toEqual([item]))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.error).toBe(true))
  expect(result.current.items).toEqual([item])
})

it('blocks pagination while reactivation is replacing the first page', async () => {
  let finish!: (page: unknown) => void
  const page = vi
    .fn()
    .mockResolvedValueOnce({ items: [{ id: 'old' }], nextCursor: 'old-cursor' })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ items: [{ id: 'next' }], nextCursor: null })
  const sources = [{ myWork: { page } } as unknown as SharedWorkspaceApi]
  const { result, rerender } = renderHook(
    ({ active }) => usePersonalHomeIssues(sources, active, true, false, [7]),
    { initialProps: { active: true } }
  )
  await waitFor(() => expect(result.current.items[0]?.id).toBe('old'))
  rerender({ active: false })
  rerender({ active: true })
  await act(async () => result.current.loadMore())
  expect(page).toHaveBeenCalledTimes(2)
  expect(result.current.loading).toBe(true)
  await act(async () => finish({ items: [{ id: 'fresh' }], nextCursor: 'fresh-cursor' }))
  await act(async () => result.current.loadMore())
  expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'fresh-cursor' }))
  expect(result.current.items.map(item => item.id)).toEqual(['fresh', 'next'])
})
