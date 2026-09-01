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
        headers: expect.objectContaining({
          'x-request-id': expect.stringMatching(/^wework-local-/),
        }),
        body: expect.stringContaining('"method":"runtime.tasks.list"'),
      })
    )
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(request).toMatchObject({
      id: expect.stringMatching(/^wework-local-/),
      method: 'runtime.tasks.list',
      params: { archived: false },
    })
    expect(request.id).toBe(
      (fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['x-request-id']
    )
  })

  test('preserves structured executor errors', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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
    expect(warning).toHaveBeenCalledWith(
      '[Wework] Executor RPC request failed',
      expect.objectContaining({
        request_id: expect.stringMatching(/^wework-local-/),
        method: 'runtime.tasks.list',
        status: 503,
        code: 'runtime_unavailable',
        retryable: true,
      })
    )
    warning.mockRestore()
  })

  test('logs correlated metadata when an executor response is not valid json', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json', { status: 502 }))
    )

    await expect(requestDshExecutor('runtime.tasks.list')).rejects.toBeInstanceOf(SyntaxError)
    expect(warning).toHaveBeenCalledWith(
      '[Wework] Executor RPC response parsing failed',
      expect.objectContaining({
        request_id: expect.stringMatching(/^wework-local-/),
        method: 'runtime.tasks.list',
        status: 502,
        error_type: 'SyntaxError',
      })
    )
    warning.mockRestore()
  })

  test('delivers text deltas without waiting for animation frames', () => {
    let onMessage: ((event: MessageEvent<string>) => void) | null = null
    vi.stubGlobal(
      'EventSource',
      class {
        set onmessage(handler: ((event: MessageEvent<string>) => void) | null) {
          onMessage = handler
        }

        set onerror(_handler: (() => void) | null) {}

        close() {}
      }
    )
    const requestAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    const listener = vi.fn()

    const unsubscribe = subscribeDshExecutorEvents(listener)
    emitExecutorEvent(onMessage, eventEnvelope(1, 'response.output_text.delta', 'first', 0))
    emitExecutorEvent(onMessage, eventEnvelope(2, 'response.output_text.delta', 'second', 5))

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sequence: 1,
        event: 'response.output_text.delta',
        payload: expect.objectContaining({
          data: expect.objectContaining({ delta: 'first', offset: 0 }),
        }),
      })
    )
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sequence: 2,
        payload: expect.objectContaining({
          data: expect.objectContaining({ delta: 'second', offset: 5 }),
        }),
      })
    )
    expect(requestAnimationFrame).not.toHaveBeenCalled()

    unsubscribe()
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
    expect(sources[0].url).toBe('/wework/executor/v1/events?after=0&replay=0')
    sources[0].onopen?.()
    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 6,
        emittedAt: '2026-08-25T00:00:00.000Z',
        event: 'executor.stream.cursor',
        payload: {},
      }),
    } as MessageEvent)
    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 7,
        emittedAt: '2026-08-25T00:00:00.000Z',
        event: 'response.created',
        payload: { taskId: 'task-1' },
      }),
    } as MessageEvent)

    reconnectDshExecutorEvents()

    expect(sources).toHaveLength(2)
    expect(sources[0].closed).toBe(true)
    expect(sources[1].url).toBe('/wework/executor/v1/events?after=7&replay=1')

    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 8,
        emittedAt: '2026-08-25T00:00:01.000Z',
        event: 'response.created',
        payload: { taskId: 'stale-task' },
      }),
    } as MessageEvent)
    sources[1].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 8,
        emittedAt: '2026-08-25T00:00:01.000Z',
        event: 'response.created',
        payload: { taskId: 'task-2' },
      }),
    } as MessageEvent)

    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(sources[1].closed).toBe(true)
  })

  test('backs off and reconnects after a malformed executor event', () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
    const unsubscribe = subscribeDshExecutorEvents(vi.fn())

    sources[0].onopen?.()
    sources[0].onmessage?.({ data: '{invalid' } as MessageEvent)

    expect(sources[0].closed).toBe(true)
    expect(sources).toHaveLength(1)
    vi.advanceTimersByTime(499)
    expect(sources).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(2)
    expect(sources[1].url).toBe('/wework/executor/v1/events?after=0&replay=1')

    unsubscribe()
    consoleError.mockRestore()
    vi.useRealTimers()
  })

  test('advances the cursor when one event listener throws', () => {
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const listener = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('reducer failed')
      })
      .mockImplementation(() => undefined)
    const unsubscribe = subscribeDshExecutorEvents(listener)

    sources[0].onopen?.()
    emitExecutorEvent(sources[0].onmessage, eventEnvelope(1, 'response.block.updated'))
    emitExecutorEvent(sources[0].onmessage, eventEnvelope(2, 'response.completed'))
    reconnectDshExecutorEvents()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(sources[1].url).toBe('/wework/executor/v1/events?after=2&replay=1')

    unsubscribe()
    consoleError.mockRestore()
  })
})

function emitExecutorEvent(
  onMessage: ((event: MessageEvent<string>) => void) | null,
  event: Record<string, unknown>
) {
  onMessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
}

function eventEnvelope(
  sequence: number,
  event: string,
  delta?: string,
  offset?: number
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    sequence,
    emittedAt: `2026-08-25T00:00:0${sequence}.000Z`,
    event,
    payload: {
      taskId: 'task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      data:
        delta === undefined
          ? { value: 'complete' }
          : {
              itemId: 'assistant-1',
              delta,
              offset,
            },
    },
  }
}

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {}

  close() {
    this.closed = true
  }
}
