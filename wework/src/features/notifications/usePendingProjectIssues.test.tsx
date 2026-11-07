import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { CloudMyWorkItem } from '@/api/deliveries'
import { NotificationTaskContext, type TaskSource } from './NotificationTaskSourceContext'
import { usePendingProjectIssues } from './usePendingProjectIssues'

const item = {
  id: 'ISSUE-1',
  cloud_project_id: 'project',
  created_by_user_id: 7,
  title: 'My project work',
  status: 'pending',
  project_name: 'Project',
} as CloudMyWorkItem
function taskSource(services: unknown, userId = 7): TaskSource {
  return {
    services: services as WorkbenchServices,
    userId,
    items: [],
    unreadTaskKeys: new Set(),
    markRuntimeTaskRead: vi.fn(),
  }
}

it('continues through an empty cursor page and filters actual human ownership', async () => {
  const read = vi.fn(async (options?: { cursor?: string }) =>
    options?.cursor
      ? {
          items: [
            item,
            { ...item, id: 'other', created_by_user_id: 8 },
            { ...item, id: 'running', execution_state: 'running' },
          ],
          next_cursor: null,
        }
      : { items: [], next_cursor: 'next-page' }
  )
  const source = taskSource({ projectSpaceApis: { cloud: { listMyWork: read } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NotificationTaskContext.Provider value={{ taskSource: source, registerTaskSource: vi.fn() }}>
      {children}
    </NotificationTaskContext.Provider>
  )
  const { result } = renderHook(() => usePendingProjectIssues(true), { wrapper })
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  expect(result.current.items[0].item.id).toBe(item.id)
  expect(read).toHaveBeenCalledWith({ cursor: 'next-page' })
  await waitFor(() => expect(result.current.loading).toBe(false))
})

it('keeps local results usable when the cloud is offline and does no reads on inactive pages', async () => {
  const local = vi.fn().mockResolvedValue({ items: [{ ...item, created_by_user_id: 0 }] })
  const cloud = vi.fn().mockRejectedValue(new Error('Cloud offline'))
  const source = taskSource({
    projectSpaceApis: { local: { listMyWork: local }, cloud: { listMyWork: cloud } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NotificationTaskContext.Provider value={{ taskSource: source, registerTaskSource: vi.fn() }}>
      {children}
    </NotificationTaskContext.Provider>
  )
  const { result, rerender } = renderHook(({ active }) => usePendingProjectIssues(active), {
    wrapper,
    initialProps: { active: false },
  })
  expect(local).not.toHaveBeenCalled()
  rerender({ active: true })
  await waitFor(() => expect(result.current.errors.backend).toBe('Cloud offline'))
  expect(result.current.items).toHaveLength(1)
  expect(result.current.items[0].store).toBe('local')
})

it('clears old account data and ignores an old in-flight result after scope changes', async () => {
  let complete!: (value: { items: CloudMyWorkItem[] }) => void
  const old = vi.fn(
    () =>
      new Promise<{ items: CloudMyWorkItem[] }>(resolve => {
        complete = resolve
      })
  )
  let source = taskSource({ projectSpaceApis: { cloud: { listMyWork: old } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NotificationTaskContext.Provider value={{ taskSource: source, registerTaskSource: vi.fn() }}>
      {children}
    </NotificationTaskContext.Provider>
  )
  const { result, rerender } = renderHook(() => usePendingProjectIssues(true), { wrapper })
  await waitFor(() => expect(old).toHaveBeenCalled())
  source = taskSource(
    { projectSpaceApis: { cloud: { listMyWork: vi.fn().mockResolvedValue({ items: [] }) } } },
    8
  )
  rerender()
  await act(async () => complete({ items: [item] }))
  expect(result.current.items).toEqual([])
})
