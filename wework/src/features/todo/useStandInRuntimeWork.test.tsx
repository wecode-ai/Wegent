import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useStandInRuntimeWork } from './useStandInRuntimeWork'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorkListResponse } from '@/types/api'

type Api = NonNullable<WorkbenchServices['runtimeWorkApi']>
const work = (totalTasks: number): RuntimeWorkListResponse => ({
  projects: [],
  chats: [],
  totalTasks,
})
vi.mock('@/lib/stand-in-error-message', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/stand-in-error-message')>()),
  reportStandInError: vi.fn(),
}))

test('refresh failure retains current work and an explicit retry clears the error on success', async () => {
  let resolve!: (value: RuntimeWorkListResponse) => void
  const list = vi
    .fn()
    .mockResolvedValueOnce(work(1))
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(
      () =>
        new Promise<RuntimeWorkListResponse>(done => {
          resolve = done
        })
    )
  const api = { listRuntimeWork: list } as unknown as Api
  const { result } = renderHook(() => useStandInRuntimeWork(api, 'A'))
  await waitFor(() => expect(result.current.runtimeWork?.totalTasks).toBe(1))
  act(() => result.current.retryRuntimeWork())
  await waitFor(() => expect(result.current.runtimeError).not.toBeNull())
  expect(result.current.runtimeWork?.totalTasks).toBe(1)
  act(() => result.current.retryRuntimeWork())
  expect(result.current.runtimeError).not.toBeNull()
  await act(async () => resolve(work(2)))
  expect(result.current.runtimeWork?.totalTasks).toBe(2)
  expect(result.current.runtimeError).toBeNull()
})

test('a response from the previous API and device cannot replace the current environment', async () => {
  let resolve!: (value: RuntimeWorkListResponse) => void
  const first = {
    listRuntimeWork: () =>
      new Promise<RuntimeWorkListResponse>(done => {
        resolve = done
      }),
  } as unknown as Api
  const second = { listRuntimeWork: vi.fn().mockResolvedValue(work(2)) } as unknown as Api
  const { result, rerender } = renderHook(({ api, device }) => useStandInRuntimeWork(api, device), {
    initialProps: { api: first, device: 'A' },
  })
  rerender({ api: second, device: 'B' })
  await act(async () => resolve(work(1)))
  await waitFor(() => expect(result.current.runtimeWork?.totalTasks).toBe(2))
  expect(result.current.runtimeError).toBeNull()
})

test('disabled readers do not request work and reactivation refreshes retained data', async () => {
  const list = vi.fn().mockResolvedValueOnce(work(1)).mockResolvedValueOnce(work(2))
  const api = { listRuntimeWork: list } as unknown as Api
  const { result, rerender } = renderHook(
    ({ enabled }) => useStandInRuntimeWork(api, 'A', enabled),
    { initialProps: { enabled: false } }
  )
  expect(list).not.toHaveBeenCalled()
  rerender({ enabled: true })
  await waitFor(() => expect(result.current.runtimeWork?.totalTasks).toBe(1))
  rerender({ enabled: false })
  expect(result.current.runtimeWork?.totalTasks).toBe(1)
  rerender({ enabled: true })
  await waitFor(() => expect(result.current.runtimeWork?.totalTasks).toBe(2))
  expect(list).toHaveBeenCalledTimes(2)
})
