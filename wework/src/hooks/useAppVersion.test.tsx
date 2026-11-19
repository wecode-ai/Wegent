import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createAppVersionStore, useAppVersion } from './useAppVersion'

const runtime = vi.hoisted(() => ({ desktop: false, read: vi.fn() }))
vi.mock('@/lib/runtime-environment', () => ({ isDesktopRuntime: () => runtime.desktop }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: runtime.read }))
afterEach(() => {
  runtime.desktop = false
  runtime.read.mockReset()
})

test('browser version needs no desktop request', () => {
  expect(renderHook(useAppVersion).result.current).toBe(__WEWORK_APP_VERSION__)
  expect(runtime.read).not.toHaveBeenCalled()
})

test('desktop consumers share the immutable version request', async () => {
  runtime.desktop = true
  runtime.read.mockResolvedValue({ version: '1.2.3' })
  const first = renderHook(useAppVersion)
  const second = renderHook(useAppVersion)
  await waitFor(() => expect(first.result.current).toBe('1.2.3'))
  expect(second.result.current).toBe('1.2.3')
  expect(runtime.read).toHaveBeenCalledTimes(1)
})

test('late replies update the cache without notifying an unmounted consumer', async () => {
  let resolve!: (value: string) => void
  const read = vi.fn(
    () =>
      new Promise<string>(done => {
        resolve = done
      })
  )
  const store = createAppVersionStore(read)
  const listener = vi.fn()
  const unsubscribe = store.subscribe(listener)
  expect(read).toHaveBeenCalledTimes(1)
  unsubscribe()
  await act(async () => resolve('2.0.0'))
  expect(listener).not.toHaveBeenCalled()
  expect(store.getSnapshot()).toBe('2.0.0')
  store.subscribe(listener)()
  expect(read).toHaveBeenCalledTimes(1)
})
