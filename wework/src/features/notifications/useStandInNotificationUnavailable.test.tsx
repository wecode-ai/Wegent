// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useStandInNotificationUnavailable } from './useStandInNotificationUnavailable'

const mocks = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
  subscribeDesktopHostEvents: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invokeDesktopHost,
  subscribeDesktopHostEvents: mocks.subscribeDesktopHostEvents,
}))

vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))

describe('stand-in notification availability', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.invokeDesktopHost.mockReset()
    mocks.subscribeDesktopHostEvents.mockReset().mockReturnValue(() => undefined)
  })

  test('reports unreachable support probes and asynchronous host failures', async () => {
    mocks.invokeDesktopHost.mockRejectedValueOnce(new Error('capability unavailable'))
    const probe = renderHook(() => useStandInNotificationUnavailable())
    await waitFor(() => expect(probe.result.current).toBe(true))
    probe.unmount()

    mocks.invokeDesktopHost.mockResolvedValueOnce(true)
    let hostListener: ((event: { type: string; payload: { status: string } }) => void) | undefined
    mocks.subscribeDesktopHostEvents.mockImplementationOnce(listener => {
      hostListener = listener
      return () => undefined
    })
    const live = renderHook(() => useStandInNotificationUnavailable())
    await waitFor(() => expect(live.result.current).toBe(false))
    act(() => hostListener?.({ type: 'notification-lifecycle', payload: { status: 'failed' } }))
    expect(live.result.current).toBe(true)
    live.unmount()
  })
})
