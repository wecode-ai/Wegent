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
    mocks.cancel.mockReset()
    mocks.poll.mockReset()
    mocks.start.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
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
