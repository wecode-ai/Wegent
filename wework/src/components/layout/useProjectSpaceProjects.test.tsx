import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { useProjectSpaceProjects } from './useProjectSpaceProjects'

const project = (id: string, project_store: 'local' | 'backend' = 'local') =>
  ({ id, project_store }) as CloudProject
function source(list: () => Promise<{ items: CloudProject[] }>) {
  return { listCloudProjects: vi.fn(list) } as unknown as ProjectSpaceApi
}

test('merges arriving sources and deduplicates by project and storage identity', async () => {
  let resolve!: (value: { items: CloudProject[] }) => void
  const local = source(async () => ({ items: [project('A')] }))
  const cloud = source(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const { result } = renderHook(() => useProjectSpaceProjects(true, [local, cloud]))
  await waitFor(() => expect(result.current).toEqual([project('A')]))
  await act(async () => resolve({ items: [project('A'), project('A', 'backend')] }))
  expect(result.current).toEqual([project('A'), project('A', 'backend')])
  expect(local.listCloudProjects).toHaveBeenCalledTimes(1)
  expect(cloud.listCloudProjects).toHaveBeenCalledTimes(1)
})

test('retains unchanged sources while removing a replaced source and ignoring its late response', async () => {
  let finish!: (value: { items: CloudProject[] }) => void
  const stable = source(async () => ({ items: [project('stable')] }))
  const old = source(
    () =>
      new Promise(done => {
        finish = done
      })
  )
  const fresh = source(async () => ({ items: [project('fresh')] }))
  const { result, rerender } = renderHook(({ apis }) => useProjectSpaceProjects(true, apis), {
    initialProps: { apis: [stable, old] },
  })
  await waitFor(() => expect(result.current).toEqual([project('stable')]))
  rerender({ apis: [stable, fresh] })
  expect(result.current).toEqual([project('stable')])
  await act(async () => finish({ items: [project('old')] }))
  await waitFor(() => expect(result.current).toEqual([project('stable'), project('fresh')]))
})

test('inactive lists do no IO and reactivation refreshes the current sources', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [project('first')] })
    .mockResolvedValueOnce({ items: [project('second')] })
  const api = source(list)
  const { result, rerender } = renderHook(({ active }) => useProjectSpaceProjects(active, [api]), {
    initialProps: { active: false },
  })
  expect(list).not.toHaveBeenCalled()
  rerender({ active: true })
  await waitFor(() => expect(result.current).toEqual([project('first')]))
  rerender({ active: false })
  expect(result.current).toEqual([project('first')])
  rerender({ active: true })
  await waitFor(() => expect(result.current).toEqual([project('second')]))
})
