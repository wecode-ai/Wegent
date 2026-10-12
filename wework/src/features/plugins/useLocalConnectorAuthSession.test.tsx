import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useLocalConnectorAuthSession } from './useLocalConnectorAuthSession'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  poll: vi.fn(),
  start: vi.fn(),
}))

vi.mock('@/api/local/localConnectorAuth', () => ({
  isLocalBrowserConnector: () => false,
  localConnectorAuthCancel: (...args: unknown[]) => mocks.cancel(...args),
  localConnectorAuthPoll: (...args: unknown[]) => mocks.poll(...args),
  localConnectorAuthStart: (...args: unknown[]) => mocks.start(...args),
  pollIntervalMs: () => 100,
}))

describe('useLocalConnectorAuthSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.cancel.mockReset().mockResolvedValue({ status: 'cancelled' })
    mocks.poll.mockReset()
    mocks.start.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test.each(['waiting_scan', 'ok'] as const)(
    'cleans up only unfinished %s sessions when the card unmounts',
    async status => {
      mocks.start.mockResolvedValue({ status, sessionId: 'session-1' })
      const { unmount } = renderHook(() =>
        useLocalConnectorAuthSession({
          enabled: true,
          target: { pluginKey: 'plugin', connectorSlug: 'connector' },
          t: ((_key: string, fallback: string) => fallback) as never,
          onSuccess: vi.fn(),
        })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      unmount()

      expect(mocks.cancel).toHaveBeenCalledTimes(status === 'ok' ? 0 : 1)
      if (status !== 'ok') {
        expect(mocks.cancel).toHaveBeenCalledWith(
          { pluginKey: 'plugin', connectorSlug: 'connector' },
          'session-1'
        )
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(mocks.poll).not.toHaveBeenCalled()
    }
  )

  test('cancels a late start response after the pending draft was discarded', async () => {
    let finishStart!: (value: { status: string; sessionId: string }) => void
    mocks.start.mockReturnValue(
      new Promise(resolve => {
        finishStart = resolve
      })
    )
    const onSuccess = vi.fn()
    const { unmount } = renderHook(() =>
      useLocalConnectorAuthSession({
        enabled: true,
        target: { pluginKey: 'plugin', connectorSlug: 'connector' },
        t: ((_key: string, fallback: string) => fallback) as never,
        onSuccess,
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    unmount()

    await act(async () => {
      finishStart({ status: 'waiting_scan', sessionId: 'late-session' })
    })

    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
      { pluginKey: 'plugin', connectorSlug: 'connector' },
      'late-session'
    )
    expect(onSuccess).not.toHaveBeenCalled()
    expect(mocks.poll).not.toHaveBeenCalled()
  })

  test('ignores a successful poll received after the card was dismissed', async () => {
    let finishPoll!: (value: { status: string }) => void
    mocks.start.mockResolvedValue({ status: 'waiting_scan', sessionId: 'session-1' })
    mocks.poll.mockReturnValue(
      new Promise(resolve => {
        finishPoll = resolve
      })
    )
    const onSuccess = vi.fn()
    const { unmount } = renderHook(() =>
      useLocalConnectorAuthSession({
        enabled: true,
        target: { pluginKey: 'plugin', connectorSlug: 'connector' },
        t: ((_key: string, fallback: string) => fallback) as never,
        onSuccess,
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
    unmount()

    await act(async () => {
      finishPoll({ status: 'ok' })
    })

    expect(onSuccess).not.toHaveBeenCalled()
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
      { pluginKey: 'plugin', connectorSlug: 'connector' },
      'session-1'
    )
  })

  test.each(['error', 'expired', 'cancelled'] as const)(
    'does not poll after a terminal %s start result',
    async status => {
      mocks.start.mockResolvedValue({ status, hint: `terminal ${status}`, sessionId: 'session-1' })
      const onSuccess = vi.fn()
      const { result } = renderHook(() =>
        useLocalConnectorAuthSession({
          enabled: true,
          target: { pluginKey: 'plugin', connectorSlug: 'connector' },
          t: ((_key: string, fallback: string) => fallback) as never,
          onSuccess,
        })
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(result.current.error).toBe(`terminal ${status}`)
      expect(result.current.canRetry).toBe(true)
      expect(mocks.poll).not.toHaveBeenCalled()
      expect(onSuccess).not.toHaveBeenCalled()
    }
  )
})
