import {
  beginPluginDeviceSync,
  clearPluginDeviceAutoSyncAttempts,
} from '@/features/plugins/pluginDeviceAutoSync'
import { reconcilePluginRefresh } from '@/features/plugins/pluginRefreshReconciliation'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { usePluginRefreshReconciliation } from './usePluginRefreshReconciliation'

vi.mock('@/features/plugins/pluginRefreshReconciliation', () => ({
  reconcilePluginRefresh: vi.fn(),
}))
beforeEach(() => {
  vi.mocked(reconcilePluginRefresh).mockReset().mockResolvedValue(undefined)
  clearPluginDeviceAutoSyncAttempts()
})
function options() {
  return {
    request: 0,
    accountKey: 'account',
    deviceId: 'device',
    available: true,
    busy: false,
    operations: { readStore: vi.fn(), sync: vi.fn(), readCloud: vi.fn(), invalidate: vi.fn() },
    onComplete: vi.fn(),
    onError: vi.fn(),
  }
}
test('waits for an existing device operation and rejects old account completion', async () => {
  const release = beginPluginDeviceSync('device')!
  const initial = { ...options(), request: 1 }
  let finish!: () => void
  let reportProgress!: (stage: 'syncing') => void
  vi.mocked(reconcilePluginRefresh).mockImplementation(
    options =>
      new Promise(resolve => {
        finish = resolve
        reportProgress = stage => options.onProgress?.(stage)
      })
  )
  const { rerender, result } = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  expect(reconcilePluginRefresh).not.toHaveBeenCalled()
  release()
  await waitFor(() => expect(reconcilePluginRefresh).toHaveBeenCalledOnce())
  rerender({ ...initial, accountKey: 'other-account' })
  act(() => reportProgress('syncing'))
  expect(result.current.stage).toBe('waiting')
  await act(async () => finish())
  expect(initial.onComplete).not.toHaveBeenCalled()
  expect(initial.onError).not.toHaveBeenCalled()
  expect(beginPluginDeviceSync('device')).not.toBeNull()
})
test('offline refresh reports an error without requesting mutations', async () => {
  const initial = { ...options(), request: 1, available: false }
  renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  await waitFor(() => expect(initial.onError).toHaveBeenCalledOnce())
  expect(reconcilePluginRefresh).not.toHaveBeenCalled()
})

test('does not revive an old reconciliation after switching accounts and back', async () => {
  const initial = { ...options(), request: 1 }
  let finish!: () => void
  let captured!: Parameters<typeof reconcilePluginRefresh>[0]
  vi.mocked(reconcilePluginRefresh).mockImplementation(
    options =>
      new Promise(resolve => {
        captured = options
        finish = resolve
      })
  )
  const { rerender, result } = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  await waitFor(() => expect(reconcilePluginRefresh).toHaveBeenCalledOnce())
  rerender({ ...initial, accountKey: 'other-account', request: 0 })
  rerender(initial)
  expect(captured.isCurrent()).toBe(false)
  act(() => captured.onProgress?.('syncing'))
  expect(result.current.stage).toBe('waiting')
  await act(async () => finish())
  expect(initial.onComplete).not.toHaveBeenCalled()
  expect(initial.onError).not.toHaveBeenCalled()
  expect(reconcilePluginRefresh).toHaveBeenCalledOnce()
})

test('clears queued refresh activity when the shared device lease times out', async () => {
  vi.useFakeTimers()
  const release = beginPluginDeviceSync('device')!
  const initial = { ...options(), request: 1 }
  const view = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  try {
    expect(view.result.current.active).toBe(true)
    expect(view.result.current.stage).toBe('waiting')
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(initial.onError).toHaveBeenCalledExactlyOnceWith(
      new Error('Plugin synchronization is busy; refresh again')
    )
    expect(view.result.current.active).toBe(false)
    expect(reconcilePluginRefresh).not.toHaveBeenCalled()
  } finally {
    view.unmount()
    release()
    vi.useRealTimers()
  }
})
