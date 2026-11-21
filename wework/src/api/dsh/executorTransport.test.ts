import {
  describeDshExecutor,
  DshExecutorTransportError,
  reconnectDshExecutorEvents,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from './executorTransport'
import { logModelLoading } from '@/lib/model-loading-diagnostics'
import {
  armRuntimeTransportGate,
  readRuntimeTransportGate,
  resetRuntimeTransportGates,
} from '@/e2e/runtime-transport-gates'

vi.mock('@/lib/model-loading-diagnostics', () => ({ logModelLoading: vi.fn() }))

describe('DSH executor transport', () => {
  test('persists directory RPC diagnostics beyond startup without request paths', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(60_000)
    vi.mocked(logModelLoading).mockClear()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, result: { success: true } }), { status: 200 })
        )
    )
    try {
      await requestDshExecutor('device.execute_command', {
        command_key: 'home_dir',
        path: '/private/path',
      })
      expect(logModelLoading).toHaveBeenCalledWith(
        expect.any(String),
        'rpc.device.execute_command.fetch_started',
        expect.any(Object)
      )
      expect(logModelLoading).toHaveBeenCalledWith(
        expect.any(String),
        'rpc.device.execute_command.body_parsed',
        expect.objectContaining({ ok: true })
      )
      expect(JSON.stringify(vi.mocked(logModelLoading).mock.calls)).not.toContain('/private/path')
    } finally {
      clock.mockRestore()
    }
  })

  afterEach(() => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    resetRuntimeTransportGates()
    vi.unstubAllEnvs()
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
                runtime_instance_id: 'runtime-1',
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
      runtime_instance_id: 'runtime-1',
      capabilities: ['runtime.tasks'],
    })
  })

  test.each([undefined, null, '', '  ', 1])(
    'rejects a managed executor with invalid Runtime identity %s',
    async runtimeInstanceId => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                protocolVersion: 1,
                executor: {
                  protocol_version: 1,
                  device_id: 'device-1',
                  runtime_instance_id: runtimeInstanceId,
                },
              })
            )
        )
      )
      await expect(describeDshExecutor()).rejects.toMatchObject({
        code: 'protocol_mismatch',
        message: 'DSH executor returned a missing or invalid Runtime identity',
      })
    }
  )

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
    expect(logModelLoading).toHaveBeenCalledWith(
      request.id,
      'rpc.runtime.tasks.list.fetch_started',
      expect.objectContaining({ elapsedMs: expect.any(Number) })
    )
    expect(logModelLoading).toHaveBeenCalledWith(
      request.id,
      'rpc.runtime.tasks.list.body_parsed',
      expect.objectContaining({ ok: true })
    )
  })

  test('E2E observes real request parameters before response headers arrive', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    armRuntimeTransportGate({
      id: 'read-request',
      kind: 'request',
      name: 'runtime.tasks.transcript',
      hold: false,
    })
    let release!: (response: Response) => void
    const headers = new Promise<Response>(resolve => {
      release = resolve
    })
    const fetchMock = vi.fn<typeof fetch>(() => headers)
    vi.stubGlobal('fetch', fetchMock)
    const request = requestDshExecutor('runtime.tasks.transcript', {
      taskId: 'real-task',
      limit: 5,
    })
    expect(readRuntimeTransportGate('read-request')?.value).toEqual({
      params: { taskId: 'real-task', limit: 5 },
    })
    expect(readRuntimeTransportGate('read-request')?.deliveries).toBe(1)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()
    release(new Response(JSON.stringify({ ok: true, result: { turns: [] } })))
    await expect(request).resolves.toEqual({ turns: [] })
  })

  test('production RPCs never record request parameters in E2E gates', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    armRuntimeTransportGate({
      id: 'production-read',
      kind: 'request',
      name: 'runtime.tasks.transcript',
      hold: false,
    })
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })))
    )
    await requestDshExecutor('runtime.tasks.transcript', { taskId: 'private-task' })
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    expect(readRuntimeTransportGate('production-read')).toBeNull()
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

  test('forwards read cancellation without serializing the signal into request parameters', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true, result: {} }))
    )
    vi.stubGlobal('fetch', fetchMock)
    await requestDshExecutor(
      'runtime.tasks.transcript',
      { taskId: 'task' },
      { signal: controller.signal }
    )
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).params).toEqual({
      taskId: 'task',
    })
    for (const method of [
      'runtime.tasks.send',
      'runtime.tasks.search',
      'runtime.tasks.transcript.search',
    ]) {
      await requestDshExecutor(method, { taskId: 'task' }, { signal: controller.signal })
      expect(fetchMock.mock.lastCall?.[1]?.signal).toBeUndefined()
    }
  })

  test('records fetch failure correlation without logging tool arguments', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = new TypeError('Failed to fetch')
    const fetchMock = vi.fn().mockRejectedValue(error)
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(
        requestDshExecutor('runtime.mcp_apps.request', {
          privateArgument: 'private-value',
        })
      ).rejects.toMatchObject({
        name: 'DshExecutorTransportError',
        code: 'runtime_unavailable',
        retryable: true,
        cause: error,
      })
      const diagnostic = warning.mock.calls.find(([message]) =>
        String(message).startsWith('[Wework] Executor transport diagnostic ')
      )
      const request = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(
        JSON.parse(String(diagnostic?.[0]).replace('[Wework] Executor transport diagnostic ', ''))
      ).toMatchObject({
        requestId: request.id,
        method: 'runtime.mcp_apps.request',
        stage: 'fetch_failed',
        errorType: 'TypeError',
      })
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-value')
    } finally {
      warning.mockRestore()
    }
  })

  test('preserves explicit fetch cancellation', async () => {
    const error = new DOMException('Request cancelled', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
    await expect(requestDshExecutor('runtime.tasks.list')).rejects.toBe(error)
  })

  test('does not classify serialization errors as connection failures', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const params: Record<string, unknown> = {}
    params.circular = params
    await expect(requestDshExecutor('runtime.tasks.list', params)).rejects.toBeInstanceOf(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('classifies a disconnected response body as retryable', async () => {
    const error = new TypeError('Network connection lost')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockRejectedValue(error),
      })
    )
    await expect(requestDshExecutor('runtime.tasks.list')).rejects.toMatchObject({
      name: 'DshExecutorTransportError',
      retryable: true,
      cause: error,
    })
  })

  test.each([null, [], 42, 'invalid'])(
    'rejects invalid response envelope %j without retrying',
    async body => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))))
      await expect(requestDshExecutor('runtime.tasks.list')).rejects.toMatchObject({
        name: 'DshExecutorTransportError',
        code: 'protocol_mismatch',
        retryable: false,
      })
    }
  )

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

  test('shares one stream across subscribers and closes it after the last unsubscribe', () => {
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
    const failingListener = vi.fn(() => {
      throw new Error('reducer failed')
    })
    const listener = vi.fn()
    const unsubscribeFailing = subscribeDshExecutorEvents(failingListener)
    const unsubscribeFirst = subscribeDshExecutorEvents(listener)
    const unsubscribeSecond = subscribeDshExecutorEvents(listener)
    const otherListeners = Array.from({ length: 5 }, () => vi.fn())
    const unsubscribeOthers = otherListeners.map(subscribeDshExecutorEvents)

    expect(sources).toHaveLength(1)
    sources[0].onopen?.()
    emitExecutorEvent(sources[0].onmessage, eventEnvelope(1, 'response.created'))
    expect(failingListener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(2)
    otherListeners.forEach(other => expect(other).toHaveBeenCalledTimes(1))

    unsubscribeFailing()
    unsubscribeFirst()
    unsubscribeOthers.forEach(unsubscribe => unsubscribe())
    expect(sources[0].closed).toBe(false)
    reconnectDshExecutorEvents()
    expect(sources).toHaveLength(2)
    expect(sources[0].closed).toBe(true)
    expect(sources[1].url).toBe('/wework/executor/v1/events?after=1&replay=1')
    emitExecutorEvent(sources[1].onmessage, eventEnvelope(1, 'response.created'))
    expect(listener).toHaveBeenCalledTimes(2)
    emitExecutorEvent(sources[1].onmessage, eventEnvelope(2, 'response.completed'))
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribeSecond()
    expect(sources[1].closed).toBe(true)
    const unsubscribeFresh = subscribeDshExecutorEvents(listener)
    expect(sources[2].url).toBe('/wework/executor/v1/events?after=0&replay=0')
    unsubscribeSecond()
    expect(sources[2].closed).toBe(false)
    unsubscribeFresh()
    expect(sources[2].closed).toBe(true)
    consoleError.mockRestore()
  })

  test('cancels a shared reconnect when all subscribers unsubscribe', () => {
    vi.useFakeTimers()
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
    sources[0].onerror?.()
    unsubscribe()
    vi.runAllTimers()
    expect(sources).toHaveLength(1)
    expect(sources[0].closed).toBe(true)
    vi.useRealTimers()
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
