import {
  beginPluginDeviceSync,
  clearPluginDeviceAutoSyncAttempts,
} from '@/features/plugins/pluginDeviceAutoSync'
import { reconcilePluginRefresh } from '@/features/plugins/pluginRefreshReconciliation'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
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

test('HTTP reconciliation runs without a cloud device identity', async () => {
  const initial = { ...options(), request: 1, deviceId: '', localSync: true }
  renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  await waitFor(() => expect(initial.onComplete).toHaveBeenCalledOnce())
  expect(reconcilePluginRefresh).toHaveBeenCalledOnce()
  expect(initial.onError).not.toHaveBeenCalled()
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
    expect(view.result.current.waitingOnNative).toBe(false)
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

test.each([true, false])(
  'defers typed Native busy even while the UI capability flag is %s',
  async localSync => {
    vi.useFakeTimers()
    const initial = { ...options(), request: 1, localSync }
    const busy = Object.assign(new Error('busy'), { code: 'plugin_local_sync_busy' })
    vi.mocked(reconcilePluginRefresh).mockRejectedValueOnce(busy).mockResolvedValue(undefined)
    const view = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
    try {
      await act(async () => {})
      expect(initial.onError).not.toHaveBeenCalled()
      expect(initial.onComplete).not.toHaveBeenCalled()
      expect(view.result.current.active).toBe(true)
      expect(view.result.current.stage).toBe('waiting')
      expect(view.result.current.waitingOnNative).toBe(true)
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(reconcilePluginRefresh).toHaveBeenCalledTimes(2)
      expect(initial.onComplete).toHaveBeenCalledOnce()
      expect(initial.onError).not.toHaveBeenCalled()
      expect(view.result.current.active).toBe(false)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  }
)

test.each(['account', 'device', 'cancel', 'unmount'])(
  'cancels a deferred native check on %s changes',
  async change => {
    vi.useFakeTimers()
    const initial = { ...options(), request: 1, localSync: true }
    vi.mocked(reconcilePluginRefresh).mockRejectedValue(
      Object.assign(new Error('busy'), { code: 'plugin_local_sync_busy' })
    )
    const view = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
    try {
      await act(async () => {})
      expect(initial.onError).not.toHaveBeenCalled()
      if (change === 'unmount') view.unmount()
      else
        view.rerender({
          ...initial,
          ...(change === 'account'
            ? { accountKey: 'another-backend-and-account', request: 0 }
            : {}),
          ...(change === 'device' ? { deviceId: 'another-device', request: 0 } : {}),
          ...(change === 'cancel' ? { request: 0 } : {}),
        })
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      expect(reconcilePluginRefresh).toHaveBeenCalledOnce()
      expect(initial.onComplete).not.toHaveBeenCalled()
      expect(initial.onError).not.toHaveBeenCalled()
      if (change !== 'unmount') expect(view.result.current.active).toBe(false)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  }
)

test('bounds native busy deferrals without reporting an unverified success', async () => {
  vi.useFakeTimers()
  const initial = { ...options(), request: 1, localSync: true }
  const busy = Object.assign(new Error('busy'), { code: 'plugin_local_sync_busy' })
  vi.mocked(reconcilePluginRefresh).mockRejectedValue(busy)
  const view = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  try {
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(initial.onError).toHaveBeenCalledExactlyOnceWith(busy)
    expect(initial.onComplete).not.toHaveBeenCalled()
    expect(view.result.current.active).toBe(false)
    const attempts = vi.mocked(reconcilePluginRefresh).mock.calls.length
    expect(attempts).toBeGreaterThan(1)
    expect(attempts).toBeLessThan(25)
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(reconcilePluginRefresh).toHaveBeenCalledTimes(attempts)
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})

test.each([
  new Error('plugin_local_sync_busy'),
  Object.assign(new Error('account changed'), { code: 'plugin_route_profile_mismatch' }),
  Object.assign(new Error('download failed'), { code: 'plugin_local_apply_failed' }),
])('does not defer unrelated or untyped failures', async failure => {
  const initial = { ...options(), request: 1, localSync: true }
  vi.mocked(reconcilePluginRefresh).mockRejectedValue(failure)
  renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  await waitFor(() => expect(initial.onError).toHaveBeenCalledExactlyOnceWith(failure))
  expect(reconcilePluginRefresh).toHaveBeenCalledOnce()
  expect(initial.onComplete).not.toHaveBeenCalled()
})

test('a new explicit refresh can recover after the native waiting window expires', async () => {
  vi.useFakeTimers()
  const initial = { ...options(), request: 1, localSync: true }
  vi.mocked(reconcilePluginRefresh).mockRejectedValue(
    Object.assign(new Error('busy'), { code: 'plugin_local_sync_busy' })
  )
  const view = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  try {
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(initial.onError).toHaveBeenCalledOnce()
    expect(initial.onComplete).not.toHaveBeenCalled()
    vi.mocked(reconcilePluginRefresh).mockResolvedValue(undefined)
    view.rerender({ ...initial, request: 2 })
    await act(async () => {})
    expect(initial.onComplete).toHaveBeenCalledOnce()
    expect(initial.onError).toHaveBeenCalledOnce()
    expect(view.result.current.active).toBe(false)
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})

test('resumes a native check after a foreground mutation without reviving its old completion', async () => {
  const initial = { ...options(), request: 1, localSync: true }
  let finish!: () => void
  vi.mocked(reconcilePluginRefresh).mockImplementationOnce(
    () => new Promise(resolve => (finish = resolve))
  )
  const view = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  await waitFor(() => expect(reconcilePluginRefresh).toHaveBeenCalledOnce())
  view.rerender({ ...initial, busy: true })
  await act(async () => finish())
  expect(initial.onComplete).not.toHaveBeenCalled()
  view.rerender(initial)
  await waitFor(() => expect(initial.onComplete).toHaveBeenCalledOnce())
  expect(reconcilePluginRefresh).toHaveBeenCalledTimes(2)
  expect(initial.onError).not.toHaveBeenCalled()
})

test.each(['account', 'device', 'request', 'busy', 'offline'])(
  'fences an old native check during the commit that changes %s',
  async change => {
    const initial = { ...options(), request: 1, localSync: true }
    let captured!: Parameters<typeof reconcilePluginRefresh>[0]
    let finish!: () => void
    vi.mocked(reconcilePluginRefresh).mockImplementationOnce(
      options =>
        new Promise(resolve => {
          captured = options
          finish = resolve
        })
    )
    let observed: boolean | undefined
    const view = renderHook(
      props => {
        const result = usePluginRefreshReconciliation(props)
        useLayoutEffect(() => {
          if (props !== initial) observed = captured.isCurrent()
        }, [props])
        return result
      },
      { initialProps: initial }
    )
    await waitFor(() => expect(reconcilePluginRefresh).toHaveBeenCalledOnce())
    view.rerender({
      ...initial,
      ...(change === 'account' ? { accountKey: 'other-account' } : {}),
      ...(change === 'device' ? { deviceId: 'other-device' } : {}),
      ...(change === 'request' ? { request: 0 } : {}),
      ...(change === 'busy' ? { busy: true } : {}),
      ...(change === 'offline' ? { available: false } : {}),
    })
    expect(observed).toBe(false)
    await act(async () => finish())
    expect(initial.onComplete).not.toHaveBeenCalled()
    view.unmount()
  }
)
