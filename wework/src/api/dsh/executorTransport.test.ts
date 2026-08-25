import {
  describeDshExecutor,
  DshExecutorTransportError,
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

  test('coalesces text deltas and flushes them before a terminal event', () => {
    let onMessage: ((event: MessageEvent<string>) => void) | null = null
    const animationFrames = new Map<number, FrameRequestCallback>()
    let nextFrameId = 1
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
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const frameId = nextFrameId++
      animationFrames.set(frameId, callback)
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
      animationFrames.delete(frameId)
    })
    const listener = vi.fn()

    const unsubscribe = subscribeDshExecutorEvents(listener)
    for (let index = 0; index < 2200; index += 1) {
      emitExecutorEvent(
        onMessage,
        eventEnvelope(index + 1, 'response.output_text.delta', 'x', index)
      )
    }
    emitExecutorEvent(onMessage, eventEnvelope(2201, 'response.completed'))

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sequence: 2200,
        event: 'response.output_text.delta',
        payload: expect.objectContaining({
          data: expect.objectContaining({ delta: 'x'.repeat(2200), offset: 0 }),
        }),
      })
    )
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sequence: 2201, event: 'response.completed' })
    )
    expect(animationFrames).toHaveLength(0)

    unsubscribe()
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
