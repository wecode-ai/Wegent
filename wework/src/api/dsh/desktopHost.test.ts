import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

describe('desktop host events', () => {
  beforeEach(() => {
    vi.resetModules()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  test.each([
    { e2e: 'true', elapsedMs: 1_500, logged: true },
    { e2e: 'true', elapsedMs: 500, logged: false },
    { e2e: 'false', elapsedMs: 1_500, logged: false },
  ])('reports slow host metadata only in E2E: %j', async ({ e2e, elapsedMs, logged }) => {
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_WEWORK_E2E', e2e)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        clock.mockReturnValue(elapsedMs)
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { token: 'private-result' } }),
        }
      })
    )
    const { invokeDesktopHost } = await import('./desktopHost')
    await expect(invokeDesktopHost('secureStorage.get', { key: 'private-key' })).resolves.toEqual({
      token: 'private-result',
    })
    if (logged) {
      expect(debug).toHaveBeenCalledExactlyOnceWith(
        '[Wework] Electron host diagnostic ' +
          JSON.stringify({
            capability: 'secureStorage.get',
            phase: 'completed',
            elapsedMs,
            status: 200,
            ok: true,
          })
      )
    } else {
      expect(debug).not.toHaveBeenCalled()
    }
  })

  test('records pending metadata before a slow response and clears its timer on failure', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    let rejectRequest!: (error: Error) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((_, reject) => (rejectRequest = reject)))
    )
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { invokeDesktopHost } = await import('./desktopHost')
    const pending = invokeDesktopHost('secureStorage.get', { key: 'private-key' })
    const failed = expect(pending).rejects.toMatchObject({
      name: 'DesktopHostTransportError',
      message: 'transport closed',
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      '[Wework] Electron host diagnostic ' +
        JSON.stringify({ capability: 'secureStorage.get', phase: 'pending', elapsedMs: 1_000 })
    )
    rejectRequest(new Error('transport closed'))
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })

  test('times out a stalled attachment request as a transport failure', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      })
    )
    const { invokeDesktopHost } = await import('./desktopHost')
    const request = expect(
      invokeDesktopHost('attachment.append', { uploadId: 'upload-1', offset: 0 })
    ).rejects.toMatchObject({ name: 'DesktopHostTransportError' })

    await vi.advanceTimersByTimeAsync(15_000)
    await request
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['true', 'false'])(
    'records attachment chunk timing without its payload only in E2E: %s',
    async e2e => {
      vi.stubEnv('MODE', 'production')
      vi.stubEnv('VITE_WEWORK_E2E', e2e)
      vi.spyOn(performance, 'now').mockReturnValue(0)
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: 768 * 1024 }),
        })
      )
      const { invokeDesktopHost } = await import('./desktopHost')
      await invokeDesktopHost('attachment.append', {
        uploadId: 'private-upload-id',
        offset: 384 * 1024,
        chunkBase64: 'private-file-content',
      })
      if (e2e === 'true') {
        expect(debug).toHaveBeenCalledExactlyOnceWith(
          '[Wework] Electron host diagnostic ' +
            JSON.stringify({
              capability: 'attachment.append',
              phase: 'completed',
              elapsedMs: 0,
              status: 200,
              ok: true,
              offset: 384 * 1024,
            })
        )
      } else expect(debug).not.toHaveBeenCalled()
    }
  )

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

  test('E2E can drop a completed real host response as a transport failure', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const gates = await import('@/e2e/runtime-transport-gates')
    gates.armRuntimeTransportGate({
      id: 'finish-drop',
      kind: 'response',
      name: 'attachment.finish',
      drop: true,
    })
    const json = vi.fn().mockResolvedValue({ ok: true, result: '/draft/recovered.bin' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json }))
    const { invokeDesktopHost } = await import('./desktopHost')
    try {
      await expect(
        invokeDesktopHost('attachment.finish', { uploadId: 'upload-1' })
      ).rejects.toMatchObject({ name: 'DesktopHostTransportError' })
      expect(json).toHaveBeenCalledOnce()
      expect(gates.readRuntimeTransportGate('finish-drop')).toMatchObject({
        deliveries: 0,
        dropped: true,
      })
    } finally {
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
