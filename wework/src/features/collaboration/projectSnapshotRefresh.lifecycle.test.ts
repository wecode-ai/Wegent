// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProjectSnapshotRefresh } from './projectSnapshotRefresh'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('project metadata activation and synchronization', () => {
  it.each(['visibility', 'window focus'] as const)(
    'starts a new read after %s returns while an older read is pending',
    async source => {
      const scope = {}
      const old = deferred()
      const newer = deferred()
      const refresh = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
      const { result } = renderHook(() =>
        useProjectSnapshotRefresh({ scope, active: true, refreshKey: '0', refresh })
      )
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      act(() => {
        if (source === 'visibility') {
          visibility.mockReturnValue('hidden')
          document.dispatchEvent(new Event('visibilitychange'))
          visibility.mockReturnValue('visible')
          document.dispatchEvent(new Event('visibilitychange'))
        } else {
          window.dispatchEvent(new Event('blur'))
          window.dispatchEvent(new Event('focus'))
        }
      })
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
      expect(refresh.mock.calls[0][0]()).toBe(false)
      await act(async () => {
        newer.resolve()
        await newer.promise
      })
      expect(result.current.state).toBe('fresh')
      await act(async () => {
        old.reject(new Error('Obsolete request'))
        await old.promise.catch(() => {})
      })
      expect(result.current.state).toBe('fresh')
    }
  )

  it('revalidates on workspace reentry, manual refresh, visibility and window focus', async () => {
    const scope = {}
    const refresh = vi.fn(async () => {})
    const { result, rerender } = renderHook(
      ({ active, refreshKey }) => useProjectSnapshotRefresh({ scope, active, refreshKey, refresh }),
      { initialProps: { active: false, refreshKey: '0' } }
    )
    expect(refresh).not.toHaveBeenCalled()
    expect(result.current.canWrite).toBe(false)
    rerender({ active: true, refreshKey: '0' })
    await waitFor(() => expect(result.current.state).toBe('fresh'))
    expect(refresh).toHaveBeenCalledTimes(1)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(refresh).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(result.current.state).toBe('fresh'))
    expect(refresh).toHaveBeenCalledTimes(2)
    rerender({ active: false, refreshKey: '0' })
    rerender({ active: true, refreshKey: '0' })
    expect(result.current.canWrite).toBe(false)
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3))
    rerender({ active: true, refreshKey: '1' })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(4))
  })

  it('keeps writes blocked after failure until an explicit retry succeeds', async () => {
    const scope = {}
    const refresh = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Network failed'))
    const { result } = renderHook(() =>
      useProjectSnapshotRefresh({ scope, active: true, refreshKey: '0', refresh })
    )
    await waitFor(() => expect(result.current.state).toBe('stale'))
    expect(result.current.canWrite).toBe(false)
    await act(() => result.current.retry())
    expect(result.current.state).toBe('fresh')
    expect(result.current.canWrite).toBe(true)
  })

  it('invalidates pending reads on offline and recovers on reconnect', async () => {
    const scope = {}
    const old = deferred()
    const refresh = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(undefined)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const { result } = renderHook(() =>
      useProjectSnapshotRefresh({ scope, active: true, refreshKey: '0', refresh })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    online.mockReturnValue(false)
    act(() => window.dispatchEvent(new Event('offline')))
    expect(result.current.state).toBe('offline')
    expect(refresh.mock.calls[0][0]()).toBe(false)
    await act(async () => {
      old.resolve()
      await old.promise
    })
    expect(result.current.state).toBe('offline')
    online.mockReturnValue(true)
    act(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(result.current.state).toBe('fresh'))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('rejects late completions after switching projects and removes inactive listeners', async () => {
    const old = deferred()
    const refresh = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(undefined)
    const { result, rerender, unmount } = renderHook(
      ({ scope }) => useProjectSnapshotRefresh({ scope, active: true, refreshKey: '0', refresh }),
      { initialProps: { scope: {} } }
    )
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    rerender({ scope: {} })
    await waitFor(() => expect(result.current.state).toBe('fresh'))
    expect(refresh.mock.calls[0][0]()).toBe(false)
    await act(async () => {
      old.reject(new Error('Old request'))
      await old.promise.catch(() => {})
    })
    expect(result.current.state).toBe('fresh')
    unmount()
    window.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('disables automatic revalidation with the rollback flag', () => {
    const refresh = vi.fn(async () => {})
    const { result } = renderHook(() =>
      useProjectSnapshotRefresh({
        scope: {},
        active: true,
        refreshKey: '0',
        enabled: false,
        refresh,
      })
    )
    window.dispatchEvent(new Event('focus'))
    expect(refresh).not.toHaveBeenCalled()
    expect(result.current.canWrite).toBe(true)
  })
})
