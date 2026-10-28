import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

describe('desktop host events', () => {
  beforeEach(() => {
    vi.resetModules()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  test('E2E can delay only delivery of a completed real host response', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const gates = await import('@/e2e/runtime-transport-gates')
    gates.armRuntimeTransportGate({
      id: 'handoff',
      kind: 'response',
      name: 'smartApps.storeAdditionalProxyTokens',
      where: [{ path: 'params.installationId', equals: 'app-1' }],
    })
    const result = { stored: true }
    const response = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true, result }),
    }
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const { invokeDesktopHost } = await import('./desktopHost')
    let delivered = false
    const pending = invokeDesktopHost('smartApps.storeAdditionalProxyTokens', {
      installationId: 'app-1',
      tokens: ['test-token'],
    }).then(value => {
      delivered = true
      return value
    })
    try {
      await vi.waitFor(() => expect(gates.readRuntimeTransportGate('handoff')).not.toBeNull())
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(response.json).toHaveBeenCalledOnce()
      expect(delivered).toBe(false)
      gates.releaseRuntimeTransportGate('handoff')
      expect(await pending).toBe(result)
    } finally {
      gates.resetRuntimeTransportGates()
      await pending
    }
  })

  test('production host responses cannot be held by an E2E gate', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const gates = await import('@/e2e/runtime-transport-gates')
    gates.armRuntimeTransportGate({ id: 'production', kind: 'response', name: 'smartApps.start' })
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: 'running' }),
      })
    )
    const { invokeDesktopHost } = await import('./desktopHost')
    try {
      await expect(invokeDesktopHost('smartApps.start')).resolves.toBe('running')
      vi.stubEnv('VITE_WEWORK_E2E', 'true')
      expect(gates.readRuntimeTransportGate('production')).toBeNull()
    } finally {
      vi.stubEnv('VITE_WEWORK_E2E', 'true')
      gates.resetRuntimeTransportGates()
    }
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

    const replayedHandler = vi.fn()
    const unsubscribeReplayed = subscribeDesktopHostEvents(replayedHandler, {
      replay: event => event.type === 'tray.action',
    })
    expect(replayedHandler).toHaveBeenCalledWith({
      sequence: 1,
      type: 'tray.action',
      payload: { type: 'open-settings' },
    })

    unsubscribeFirst()
    unsubscribeSecond()
    unsubscribeReplayed()
  })

  test('keeps only the latest browser page state for each browser in a batch', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          events: [
            {
              sequence: 1,
              type: 'browser.event',
              payload: {
                type: 'page-state',
                payload: { label: 'workspace-browser', url: 'https://stale.example' },
              },
            },
            {
              sequence: 2,
              type: 'tray.action',
              payload: { type: 'open-settings' },
            },
            {
              sequence: 3,
              type: 'browser.event',
              payload: {
                type: 'page-state',
                payload: { label: 'workspace-browser', url: 'https://current.example' },
              },
            },
          ],
          latestSequence: 3,
          historyLost: false,
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { subscribeDesktopHostEvents } = await import('./desktopHost')
    const handler = vi.fn()

    const unsubscribe = subscribeDesktopHostEvents(handler)

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    expect(handler.mock.calls.map(([event]) => event.sequence)).toEqual([2, 3])
    expect(window.sessionStorage.getItem('wework.desktopHostEventCursor')).toBe('3')

    unsubscribe()
  })
})
