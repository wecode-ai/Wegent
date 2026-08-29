import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

describe('desktop host events', () => {
  beforeEach(() => {
    vi.resetModules()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('shares one bounded poll loop across subscribers and advances the cursor', async () => {
    vi.useFakeTimers()
    let resolveFirstRequest:
      | ((value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void)
      | null = null
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirstRequest = resolve
          })
      )
      .mockImplementation(
        () =>
          new Promise(() => {
            // Keep the next poll pending until the listeners are removed.
          })
      )
    vi.stubGlobal('fetch', fetchMock)
    const { subscribeDesktopHostEvents } = await import('./desktopHost')
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()

    const unsubscribeFirst = subscribeDesktopHostEvents(firstHandler)
    const unsubscribeSecond = subscribeDesktopHostEvents(secondHandler)
    resolveFirstRequest?.({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          events: [{ sequence: 1, type: 'tray.action', payload: { type: 'open-settings' } }],
          latestSequence: 1,
          historyLost: false,
        },
      }),
    })

    await vi.waitFor(() => expect(firstHandler).toHaveBeenCalledOnce())
    expect(firstHandler).toHaveBeenCalledOnce()
    expect(secondHandler).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      capability: 'desktop.events',
      params: { after: 0 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      capability: 'desktop.events',
      params: { after: 1 },
    })
    expect(window.sessionStorage.getItem('wework.desktopHostEventCursor')).toBe('1')

    unsubscribeFirst()
    unsubscribeSecond()
  })
})
