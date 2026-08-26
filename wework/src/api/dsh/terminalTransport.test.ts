import {
  DshTerminalTransportError,
  requestDshTerminal,
  resetDshTerminalTransportForTests,
  subscribeDshTerminalEvents,
  suspendDshTerminalEventDelivery,
} from './terminalTransport'

describe('DSH terminal transport', () => {
  afterEach(() => {
    resetDshTerminalTransportForTests()
    vi.unstubAllGlobals()
  })

  test('sends terminal RPC through the Core DSH same-origin route', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { session_id: 'terminal-1', sequence: 1, data: 'ready' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestDshTerminal('terminal.snapshot', { session_id: 'terminal-1' })
    ).resolves.toEqual({
      session_id: 'terminal-1',
      sequence: 1,
      data: 'ready',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/wework/terminal/v1/rpc',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          method: 'terminal.snapshot',
          params: { session_id: 'terminal-1' },
        }),
      })
    )
  })

  test('preserves structured terminal errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: 'session_not_found',
                message: 'Terminal session was not found',
                retryable: false,
              },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await expect(
      requestDshTerminal('terminal.snapshot', { session_id: 'missing' })
    ).rejects.toMatchObject<Partial<DshTerminalTransportError>>({
      code: 'session_not_found',
      retryable: false,
    })
  })

  test('resumes terminal events from the last accepted sequence', () => {
    const sources: FakeEventSource[] = []
    vi.stubGlobal(
      'EventSource',
      class extends FakeEventSource {
        constructor(url: string) {
          super(url)
          sources.push(this)
        }
      }
    )
    const listener = vi.fn()
    const unsubscribe = subscribeDshTerminalEvents(listener)
    expect(sources[0].url).toBe('/wework/terminal/v1/events?after=0')

    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 7,
        emittedAt: '2026-08-22T00:00:00.000Z',
        event: 'terminal.output',
        payload: { session_id: 'terminal-1', sequence: 1, data: 'ready' },
      }),
    } as MessageEvent)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    expect(sources[0].closed).toBe(true)
  })

  test('multiplexes terminal listeners over one event stream', () => {
    const sources: FakeEventSource[] = []
    vi.stubGlobal(
      'EventSource',
      class extends FakeEventSource {
        constructor(url: string) {
          super(url)
          sources.push(this)
        }
      }
    )
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const unsubscribeFirst = subscribeDshTerminalEvents(firstListener)
    const unsubscribeSecond = subscribeDshTerminalEvents(secondListener)

    expect(sources).toHaveLength(1)
    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 8,
        emittedAt: '2026-08-23T00:00:00.000Z',
        event: 'terminal.output',
        payload: { session_id: 'terminal-1', sequence: 2, data: 'working' },
      }),
    } as MessageEvent)
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).toHaveBeenCalledTimes(1)

    unsubscribeFirst()
    expect(sources[0].closed).toBe(false)
    unsubscribeSecond()
    expect(sources[0].closed).toBe(true)
  })

  test('queues terminal events while a screenshot capture is quiescing the renderer', () => {
    const sources: FakeEventSource[] = []
    vi.stubGlobal(
      'EventSource',
      class extends FakeEventSource {
        constructor(url: string) {
          super(url)
          sources.push(this)
        }
      }
    )
    const listener = vi.fn()
    const unsubscribe = subscribeDshTerminalEvents(listener)
    const resume = suspendDshTerminalEventDelivery()

    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 8,
        emittedAt: '2026-08-23T00:00:00.000Z',
        event: 'terminal.output',
        payload: { session_id: 'terminal-1', sequence: 2, data: 'working' },
      }),
    } as MessageEvent)
    expect(listener).not.toHaveBeenCalled()

    resume()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {}

  close() {
    this.closed = true
  }
}
