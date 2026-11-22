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

  test('shares one socket, replays events and resumes after disconnect without polling', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url: URL) {
          super(url)
          sockets.push(this)
        }
      }
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { subscribeDesktopHostEvents } = await import('./desktopHost')
    const first = vi.fn(),
      second = vi.fn()
    const unsubscribeFirst = subscribeDesktopHostEvents(first)
    const unsubscribeSecond = subscribeDesktopHostEvents(second)
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url.searchParams.get('after')).toBe('0')
    sockets[0].deliver({
      events: [{ sequence: 1, type: 'tray.action', payload: { type: 'open-settings' } }],
      latestSequence: 1,
      historyLost: false,
    })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(window.sessionStorage.getItem('wework.desktopHostEventCursor')).toBe('1')
    const replayed = vi.fn()
    const unsubscribeReplayed = subscribeDesktopHostEvents(replayed, {
      replay: event => event.type === 'tray.action',
    })
    expect(replayed).toHaveBeenCalledWith({
      sequence: 1,
      type: 'tray.action',
      payload: { type: 'open-settings' },
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    sockets[0].onclose?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].url.searchParams.get('after')).toBe('1')
    unsubscribeFirst()
    unsubscribeSecond()
    unsubscribeReplayed()
    expect(sockets[1].closed).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets).toHaveLength(2)
  })

  test('keeps only the latest browser page state for each browser in a batch', async () => {
    const sockets: FakeSocket[] = []
    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url: URL) {
          super(url)
          sockets.push(this)
        }
      }
    )
    const { subscribeDesktopHostEvents } = await import('./desktopHost')
    const handler = vi.fn()
    const unsubscribe = subscribeDesktopHostEvents(handler)
    sockets[0].deliver({
      events: [
        {
          sequence: 1,
          type: 'browser.event',
          payload: {
            type: 'page-state',
            payload: { label: 'workspace-browser', url: 'https://stale.example' },
          },
        },
        { sequence: 2, type: 'tray.action', payload: { type: 'open-settings' } },
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
    })
    expect(handler.mock.calls.map(([event]) => event.sequence)).toEqual([2, 3])
    expect(window.sessionStorage.getItem('wework.desktopHostEventCursor')).toBe('3')
    unsubscribe()
  })
})

class FakeSocket {
  onmessage?: (message: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  closed = false
  constructor(readonly url: URL) {}
  deliver(batch: unknown) {
    this.onmessage?.({ data: JSON.stringify(batch) })
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
}
