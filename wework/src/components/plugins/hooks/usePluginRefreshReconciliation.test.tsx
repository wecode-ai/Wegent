import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  beginPluginDeviceSync,
  clearPluginDeviceAutoSyncAttempts,
} from '@/features/plugins/pluginDeviceAutoSync'
import { reconcilePluginRefresh } from '@/features/plugins/pluginRefreshReconciliation'
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
test('only manual refresh requests run reconciliation and rerenders do not duplicate it', async () => {
  const initial = options()
  const { rerender } = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  expect(reconcilePluginRefresh).not.toHaveBeenCalled()
  rerender({ ...initial, request: 1 })
  await waitFor(() => expect(initial.onComplete).toHaveBeenCalledOnce())
  rerender({ ...initial, request: 1 })
  expect(reconcilePluginRefresh).toHaveBeenCalledOnce()
})
test('waits for an existing device operation and rejects old account completion', async () => {
  const release = beginPluginDeviceSync('device')!
  const initial = { ...options(), request: 1 }
  let finish!: () => void
  vi.mocked(reconcilePluginRefresh).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const { rerender } = renderHook(usePluginRefreshReconciliation, { initialProps: initial })
  expect(reconcilePluginRefresh).not.toHaveBeenCalled()
  release()
  await waitFor(() => expect(reconcilePluginRefresh).toHaveBeenCalledOnce())
  rerender({ ...initial, accountKey: 'other-account' })
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
