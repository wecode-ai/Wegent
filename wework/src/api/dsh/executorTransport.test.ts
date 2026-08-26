import {
  describeDshExecutor,
  DshExecutorTransportError,
  reconnectDshExecutorEvents,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from './executorTransport'

describe('DSH executor transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('describes the managed executor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              transport: 'managed',
              executor: {
                protocol_version: 1,
                device_id: 'device-1',
                capabilities: ['runtime.tasks'],
                renderer_methods: ['runtime.*'],
                transports: ['local-endpoint-ndjson'],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await expect(describeDshExecutor()).resolves.toMatchObject({
      device_id: 'device-1',
      capabilities: ['runtime.tasks'],
    })
  })

  test('sends RPC through the same-origin runtime route', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestDshExecutor('runtime.tasks.list', { archived: false })).resolves.toEqual({
      items: [],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/wework/executor/v1/rpc',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          method: 'runtime.tasks.list',
          params: { archived: false },
        }),
      })
    )
  })

  test('preserves structured executor errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: 'runtime_unavailable',
                message: 'Runtime is unavailable',
                retryable: true,
              },
            }),
            { status: 503, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await expect(requestDshExecutor('runtime.tasks.list')).rejects.toMatchObject<
      Partial<DshExecutorTransportError>
    >({
      code: 'runtime_unavailable',
      retryable: true,
    })
  })

  test('replaces a stale executor event stream after system resume', () => {
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
    const unsubscribe = subscribeDshExecutorEvents(listener)

    expect(sources).toHaveLength(1)
    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 7,
        emittedAt: '2026-08-25T00:00:00.000Z',
        event: 'response.output_text.delta',
        payload: { taskId: 'task-1', delta: 'before sleep' },
      }),
    } as MessageEvent)

    reconnectDshExecutorEvents()

    expect(sources).toHaveLength(2)
    expect(sources[0].closed).toBe(true)
    expect(sources[1].url).toBe('/wework/executor/v1/events?after=7')

    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 8,
        emittedAt: '2026-08-25T00:00:01.000Z',
        event: 'response.output_text.delta',
        payload: { taskId: 'task-1', delta: 'stale' },
      }),
    } as MessageEvent)
    sources[1].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 8,
        emittedAt: '2026-08-25T00:00:01.000Z',
        event: 'response.output_text.delta',
        payload: { taskId: 'task-1', delta: 'after wake' },
      }),
    } as MessageEvent)

    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(sources[1].closed).toBe(true)
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
