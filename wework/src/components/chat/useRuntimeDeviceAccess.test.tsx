import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useRuntimeDeviceAccess } from '../../../../packages/collaboration/src/conversation/useRuntimeDeviceAccess'
import type { SharedWorkspaceRuntimeApi } from '@wegent/collaboration'

test('device access stays pending until the scoped check settles; missing grants do not allow reads', async () => {
  let resolve!: (value: Record<string, 'allowed' | 'app-local-only'>) => void
  const checkDeviceAccess = vi.fn(
    () =>
      new Promise<Record<string, 'allowed'>>(done => {
        resolve = done
      })
  )
  const runtime = { checkDeviceAccess } as unknown as SharedWorkspaceRuntimeApi
  const { result } = renderHook(() => useRuntimeDeviceAccess(runtime, ['A', 'B', 'C', 'A']))
  expect(result.current.get('A')).toBe('loading')
  expect(checkDeviceAccess).toHaveBeenCalledExactlyOnceWith(['A', 'B', 'C'])
  await act(async () => resolve({ A: 'allowed', B: 'app-local-only' }))
  expect(result.current.get('A')).toBe('allowed')
  expect(result.current.get('B')).toBe('app-local-only')
  expect(result.current.get('C')).toBe('unavailable')
})

test('an old runtime response cannot grant access in a new runtime', async () => {
  let resolve!: (value: Record<string, 'allowed'>) => void
  const oldRuntime = {
    checkDeviceAccess: () =>
      new Promise<Record<string, 'allowed'>>(done => {
        resolve = done
      }),
  } as unknown as SharedWorkspaceRuntimeApi
  const newRuntime = {
    checkDeviceAccess: vi.fn().mockResolvedValue({ A: 'unavailable' }),
  } as unknown as SharedWorkspaceRuntimeApi
  const { result, rerender } = renderHook(({ runtime }) => useRuntimeDeviceAccess(runtime, ['A']), {
    initialProps: { runtime: oldRuntime },
  })
  rerender({ runtime: newRuntime })
  await act(async () => resolve({ A: 'allowed' }))
  await waitFor(() => expect(result.current.get('A')).toBe('unavailable'))
})

test('a failed check denies reads and an explicit retry checks again', async () => {
  const runtime = {
    checkDeviceAccess: vi
      .fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce({ A: 'allowed' }),
  } as unknown as SharedWorkspaceRuntimeApi
  const { result } = renderHook(() => useRuntimeDeviceAccess(runtime, ['A']))
  await waitFor(() => expect(result.current.get('A')).toBe('error'))
  expect(result.current.error).toBe('denied')
  act(() => result.current.retry())
  expect(result.current.get('A')).toBe('loading')
  await waitFor(() => expect(result.current.get('A')).toBe('allowed'))
})
