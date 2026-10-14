import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

describe('desktop storage transport diagnostics', () => {
  beforeEach(() => {
    vi.resetModules()
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron', desktopWindowLabel: 'main' }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const phases = (info: ReturnType<typeof vi.spyOn>) =>
    info.mock.calls.map(([message]) => JSON.parse(String(message).split('] ')[1]))

  test.each([
    ['rendererStorage.initialize', 'renderer-storage'],
    ['preferences.get', 'preferences'],
  ] as const)(
    'distinguishes held %s headers from held body decoding without logging payloads',
    async (capability, prefix) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
      let headers!: (value: object) => void
      let body!: (value: object) => void
      const responseBody = new Promise(resolve => {
        body = resolve
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise(resolve => {
              headers = resolve
            })
        )
      )
      const { invokeDesktopHost } = await import('./desktopHost')
      const result = invokeDesktopHost(capability, {
        entries: { secret: 'private' },
      })
      expect(phases(info).map(({ phase, status }) => [phase, status])).toEqual([
        [`${prefix}-request`, 'started'],
      ])
      headers({ ok: true, json: () => responseBody })
      await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(3))
      expect(phases(info).map(({ phase, status }) => [phase, status])).toEqual([
        [`${prefix}-request`, 'started'],
        [`${prefix}-request`, 'completed'],
        [`${prefix}-response-body`, 'started'],
      ])
      const durable = { private: 'private-result' }
      body({ ok: true, result: durable })
      await expect(result).resolves.toBe(durable)
      const recorded = phases(info)
      expect(recorded.at(-1)).toMatchObject({
        phase: `${prefix}-response-body`,
        status: 'completed',
      })
      expect(recorded.map(({ navigationTimeMs }) => navigationTimeMs)).toEqual(
        recorded.map(({ navigationTimeMs }) => navigationTimeMs).sort((a, b) => a - b)
      )
      expect(JSON.stringify(recorded)).not.toMatch(/secret|private/)
    }
  )

  test.each([
    ['rendererStorage.initialize', 'renderer-storage', 'request'],
    ['rendererStorage.initialize', 'renderer-storage', 'response-body'],
    ['preferences.get', 'preferences', 'request'],
    ['preferences.get', 'preferences', 'response-body'],
  ] as const)('preserves the %s %s %s failure identity', async (capability, prefix, stage) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const failure = new Error('private-failure')
    vi.stubGlobal(
      'fetch',
      stage === 'request'
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(failure) })
    )
    const { invokeDesktopHost } = await import('./desktopHost')
    await expect(invokeDesktopHost(capability)).rejects.toBe(failure)
    expect(phases(info).at(-1)).toMatchObject({
      phase: `${prefix}-${stage}`,
      status: 'failed',
    })
    expect(JSON.stringify(phases(info))).not.toContain('private-failure')
  })

  test.each([
    ['browser', 'rendererStorage.initialize'],
    ['electron', 'unrelated.private-capability'],
  ] as const)('does not trace %s requests for %s', async (host, capability) => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: host, desktopWindowLabel: 'main' }
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: 1 }) })
    )
    const { invokeDesktopHost } = await import('./desktopHost')
    await expect(invokeDesktopHost(capability)).resolves.toBe(1)
    expect(info).not.toHaveBeenCalled()
  })
})

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
