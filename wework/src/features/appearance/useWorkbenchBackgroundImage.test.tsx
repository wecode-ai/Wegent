import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useWorkbenchBackgroundImage } from './useWorkbenchBackgroundImage'

const load = vi.hoisted(() => vi.fn())
vi.mock('./backgroundImage', () => ({ loadWorkbenchBackgroundImage: load }))
beforeEach(() => load.mockReset())

function deferred() {
  let resolve!: (image: { url: string; release: () => void }) => void
  const promise = new Promise<{ url: string; release: () => void }>(done => {
    resolve = done
  })
  return { resolve, promise }
}

test('changing the configured path releases the old URL and never paints it for the new path', async () => {
  const first = vi.fn(),
    second = vi.fn(),
    held = deferred()
  load.mockResolvedValueOnce({ url: 'blob:A', release: first }).mockReturnValueOnce(held.promise)
  const { result, rerender, unmount } = renderHook(
    ({ path }) => useWorkbenchBackgroundImage(path),
    { initialProps: { path: 'A' } }
  )
  await waitFor(() => expect(result.current.url).toBe('blob:A'))
  rerender({ path: 'B' })
  expect(result.current.url).toBeNull()
  expect(first).toHaveBeenCalledTimes(1)
  await act(async () => held.resolve({ url: 'blob:B', release: second }))
  expect(result.current.url).toBe('blob:B')
  unmount()
  expect(second).toHaveBeenCalledTimes(1)
})

test('a URL arriving after unmount is released without becoming visible', async () => {
  const held = deferred(),
    release = vi.fn()
  load.mockReturnValue(held.promise)
  const { unmount } = renderHook(() => useWorkbenchBackgroundImage('A'))
  unmount()
  await act(async () => held.resolve({ url: 'blob:A', release }))
  expect(release).toHaveBeenCalledTimes(1)
})

test('display failures remain failed even when the asynchronous file read finishes later', async () => {
  const held = deferred(),
    release = vi.fn()
  load.mockReturnValue(held.promise)
  const { result, unmount } = renderHook(() => useWorkbenchBackgroundImage('A'))
  act(() => result.current.reportLoadError())
  await act(async () => held.resolve({ url: 'blob:A', release }))
  expect(result.current.url).toBeNull()
  expect(result.current.failed).toBe(true)
  unmount()
  expect(release).toHaveBeenCalledTimes(1)
})

test('clearing the path removes a failed image without another file read', async () => {
  load.mockRejectedValueOnce(new Error('unavailable'))
  const { result, rerender } = renderHook(
    ({ path }: { path: string | null }) => useWorkbenchBackgroundImage(path),
    { initialProps: { path: 'A' as string | null } }
  )
  await waitFor(() => expect(result.current.failed).toBe(true))
  rerender({ path: null })
  expect(result.current.failed).toBe(false)
  expect(result.current.url).toBeNull()
  expect(load).toHaveBeenCalledTimes(1)
})
