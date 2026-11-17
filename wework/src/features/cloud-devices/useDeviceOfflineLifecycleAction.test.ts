import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useDeviceOfflineLifecycleAction } from './useDeviceOfflineLifecycleAction'

afterEach(() => {
  vi.useRealTimers()
})

describe('useDeviceOfflineLifecycleAction', () => {
  test('waits for an online device to go offline before reporting recovery', async () => {
    vi.useFakeTimers()
    const requestAction = vi.fn().mockResolvedValue({ message: 'accepted' })
    const refreshDevices = vi.fn()
    const { result, rerender } = renderHook(
      ({ status }) =>
        useDeviceOfflineLifecycleAction({
          status,
          requestAction,
          refreshDevices,
          pollIntervalMs: 10,
          timeoutMs: 100,
          recoveredNoticeMs: 20,
        }),
      { initialProps: { status: 'online' as const } }
    )

    await act(async () => {
      expect(await result.current.run()).toBe(true)
    })
    expect(result.current.phase).toBe('waiting-offline')

    rerender({ status: 'offline' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.phase).toBe('waiting-online')

    rerender({ status: 'online' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.phase).toBe('recovered')

    await act(async () => vi.advanceTimersByTimeAsync(20))
    expect(result.current.phase).toBe('idle')
  })

  test('allows an offline device to recover without waiting for another offline transition', async () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ status }) =>
        useDeviceOfflineLifecycleAction({
          status,
          requestAction: vi.fn().mockResolvedValue({ message: 'accepted' }),
          refreshDevices: vi.fn(),
        }),
      { initialProps: { status: 'offline' as const } }
    )

    await act(async () => {
      await result.current.run()
    })
    expect(result.current.phase).toBe('waiting-online')

    rerender({ status: 'busy' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.phase).toBe('recovered')
  })

  test('recognizes a new runtime even when the offline transition falls between polls', async () => {
    vi.useFakeTimers()
    const requestAction = vi.fn().mockResolvedValue({ message: 'accepted' })
    const { result, rerender } = renderHook(
      ({ runtimeInstanceId }) =>
        useDeviceOfflineLifecycleAction({
          status: 'online',
          runtimeInstanceId,
          requestAction,
          refreshDevices: vi.fn(),
        }),
      { initialProps: { runtimeInstanceId: 'before' } }
    )

    await act(async () => {
      expect(await result.current.run()).toBe(true)
      expect(await result.current.run()).toBe(false)
    })
    expect(requestAction).toHaveBeenCalledTimes(1)
    expect(result.current.phase).toBe('waiting-offline')

    rerender({ runtimeInstanceId: 'after' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.phase).toBe('recovered')
  })

  test('does not accept an old runtime online event as restart recovery', async () => {
    vi.useFakeTimers()
    const requestAction = vi.fn().mockResolvedValue({ message: 'accepted' })
    const refreshDevices = vi.fn()
    const { result, rerender } = renderHook(
      ({ status, runtimeInstanceId }) =>
        useDeviceOfflineLifecycleAction({
          status,
          runtimeInstanceId,
          requestAction,
          refreshDevices,
        }),
      { initialProps: { status: 'online' as 'online' | 'offline', runtimeInstanceId: 'before' } }
    )
    await act(async () => {
      await result.current.run()
    })
    rerender({ status: 'offline', runtimeInstanceId: 'before' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.phase).toBe('waiting-online')
    rerender({ status: 'online', runtimeInstanceId: 'before' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.isPending).toBe(true)
    expect(result.current.phase).toBe('waiting-online')
    rerender({ status: 'offline', runtimeInstanceId: 'before' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.isPending).toBe(true)
    rerender({ status: 'online', runtimeInstanceId: 'after' })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(result.current.phase).toBe('recovered')
  })

  test('reports request errors without changing the observed device status', async () => {
    const { result } = renderHook(() =>
      useDeviceOfflineLifecycleAction({
        status: 'online',
        requestAction: vi.fn().mockRejectedValue(new Error('service unavailable')),
        refreshDevices: vi.fn(),
      })
    )

    await act(async () => {
      expect(await result.current.run()).toBe(false)
    })
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toBe('service unavailable')
    expect(result.current.isPending).toBe(false)
  })

  test('stops polling at the bounded timeout', async () => {
    vi.useFakeTimers()
    const refreshDevices = vi.fn()
    const { result } = renderHook(() =>
      useDeviceOfflineLifecycleAction({
        status: 'online',
        requestAction: vi.fn().mockResolvedValue({ message: 'accepted' }),
        refreshDevices,
        pollIntervalMs: 10,
        timeoutMs: 25,
      })
    )

    await act(async () => {
      await result.current.run()
    })
    await act(async () => vi.advanceTimersByTimeAsync(30))
    expect(result.current.phase).toBe('timeout')

    const callsAtTimeout = refreshDevices.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(refreshDevices).toHaveBeenCalledTimes(callsAtTimeout)
  })
})
