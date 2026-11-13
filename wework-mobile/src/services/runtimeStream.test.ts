import { base64 } from '@scure/base'
import { gzipSync, strToU8 } from 'fflate'
import { io } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeStream } from './runtimeStream'
import type { DeviceInfo } from '@/types/runtime'

vi.mock('socket.io-client', () => ({ io: vi.fn() }))

const config = {
  backendUrl: 'https://wegent.example',
  apiBaseUrl: 'https://wegent.example/api',
  socketBaseUrl: 'wss://stream.wegent.example',
  socketPath: '/socket.io',
  accessToken: 'token',
}

describe('RuntimeStream', () => {
  const handlers = new Map<string, (payload?: unknown) => void>()
  const connect = vi.fn()
  const disconnect = vi.fn()
  const emit = vi.fn()
  const streams: RuntimeStream[] = []
  async function createStream(...args: ConstructorParameters<typeof RuntimeStream>) {
    const stream = new RuntimeStream(...args)
    streams.push(stream)
    await Promise.resolve()
    return stream
  }
  afterEach(() => {
    streams.splice(0).forEach(stream => stream.dispose())
    vi.useRealTimers()
  })

  it('recovers a server namespace disconnect with the current credentials like PC', async () => {
    vi.useFakeTimers()
    const stream = await createStream(config)
    await Promise.resolve()
    const raw = vi.mocked(io).mock.results.at(-1)!.value
    raw.connected = true
    handlers.get('connect')?.()
    stream.updateAccessToken('fresh-token')
    raw.connected = false
    handlers.get('disconnect')?.('io server disconnect')
    await vi.advanceTimersByTimeAsync(1000)
    expect(io).toHaveBeenLastCalledWith(
      'wss://stream.wegent.example/wework-runtime',
      expect.objectContaining({ auth: { token: 'fresh-token', client_origin: 'wework' } })
    )
    expect(connect).toHaveBeenCalledTimes(2)
  })

  beforeEach(() => {
    handlers.clear()
    connect.mockReset().mockImplementation(() => {
      const raw = vi.mocked(io).mock.results.at(-1)?.value
      if (raw) raw.connected = true
      handlers.get('connect')?.()
    })
    disconnect.mockClear()
    emit.mockReset()
    vi.mocked(io)
      .mockReset()
      .mockReturnValue({
        connected: false,
        connect,
        disconnect,
        emit,
        on: vi.fn((name: string, handler: (payload?: unknown) => void) => {
          handlers.set(name, handler)
        }),
      } as never)
  })

  it('keeps an authenticated connection active when credentials refresh', async () => {
    const stream = await createStream(config)
    stream.updateAccessToken('token')
    stream.updateAccessToken('fresh-token')
    expect(disconnect).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledOnce()
    expect(io).toHaveBeenCalledOnce()
  })

  it('replaces a pending authentication with the refreshed credentials', async () => {
    connect.mockImplementation(() => undefined)
    const stream = await createStream(config)
    stream.updateAccessToken('token')
    expect(disconnect).not.toHaveBeenCalled()
    stream.updateAccessToken('fresh-token')
    await Promise.resolve()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(io).toHaveBeenLastCalledWith(
      'wss://stream.wegent.example/wework-runtime',
      expect.objectContaining({ auth: { token: 'fresh-token', client_origin: 'wework' } })
    )
  })

  it('recovers conversation and lifecycle state after refreshing credentials during an outage', async () => {
    vi.useFakeTimers()
    const stream = await createStream(config)
    const conversationRecovered = vi.fn()
    const lifecycleRecovered = vi.fn()
    await stream.subscribe({ deviceId: 'device', taskId: 'task' }, vi.fn(), conversationRecovered)
    stream.subscribeLifecycle(vi.fn(), lifecycleRecovered)
    const raw = vi.mocked(io).mock.results.at(-1)!.value
    raw.connected = false
    handlers.get('disconnect')?.('transport close')
    stream.updateAccessToken('fresh-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(conversationRecovered).toHaveBeenCalledOnce()
    expect(lifecycleRecovered).toHaveBeenCalledOnce()
    expect(io).toHaveBeenLastCalledWith(
      'wss://stream.wegent.example/wework-runtime',
      expect.objectContaining({ auth: { token: 'fresh-token', client_origin: 'wework' } })
    )
  })

  it('does not report recovery when refreshed credentials establish the first connection', async () => {
    connect.mockImplementation(() => undefined)
    const stream = await createStream(config)
    const recovered = vi.fn()
    stream.subscribeLifecycle(vi.fn(), recovered)
    stream.updateAccessToken('fresh-token')
    await Promise.resolve()
    vi.mocked(io).mock.results.at(-1)!.value.connected = true
    handlers.get('connect')?.()
    expect(recovered).not.toHaveBeenCalled()
  })

  it('waits for namespace authentication before a subscription is ready', async () => {
    connect.mockImplementation(() => undefined)
    const stream = await createStream(config)
    let ready = false
    const subscribed = stream
      .subscribe({ deviceId: 'device', taskId: 'task' }, vi.fn(), vi.fn())
      .then(unsubscribe => {
        ready = true
        return unsubscribe
      })
    await Promise.resolve()
    expect(ready).toBe(false)
    vi.mocked(io).mock.results.at(-1)!.value.connected = true
    handlers.get('connect')?.()
    const unsubscribe = await subscribed
    expect(ready).toBe(true)
    unsubscribe()
  })

  it('loads transcripts through the Wework runtime request protocol', async () => {
    emit.mockImplementation((name, payload, acknowledge) => {
      expect(name).toBe('runtime:request')
      expect(payload).toMatchObject({
        method: 'runtime.tasks.transcript',
        device_id: 'device-1',
        timeout_seconds: 15,
        params: {
          deviceId: 'device-1',
          taskId: 'task-1',
          limit: 5,
        },
      })
      acknowledge({
        ok: true,
        result: {
          taskId: 'task-1',
          workspacePath: '/work',
          runtime: 'codex',
          turns: [],
          runtimeTurns: [],
          messages: [{ id: 'user-1', role: 'user', content: 'pwd' }],
        },
      })
    })
    const stream = await createStream(config)

    await expect(
      stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })
    ).resolves.toMatchObject({ taskId: 'task-1', messages: [{ content: 'pwd' }] })
  })

  it('loads the preceding transcript page with the server cursor', async () => {
    emit.mockImplementation((name, payload, acknowledge) => {
      expect(name).toBe('runtime:request')
      expect(payload).toMatchObject({
        method: 'runtime.tasks.transcript',
        params: {
          deviceId: 'device-1',
          taskId: 'task-1',
          limit: 5,
          beforeCursor: 'offset:15',
        },
      })
      acknowledge({
        ok: true,
        result: {
          taskId: 'task-1',
          workspacePath: '/work',
          runtime: 'codex',
          turns: [],
          runtimeTurns: [],
          messages: [{ id: 'user-older', role: 'user', content: 'older' }],
          hasMoreBefore: true,
          beforeCursor: 'offset:10',
        },
      })
    })
    const stream = await createStream(config)

    await expect(
      stream.getTranscript(
        { deviceId: 'device-1', taskId: 'task-1' },
        { beforeCursor: 'offset:15' }
      )
    ).resolves.toMatchObject({ beforeCursor: 'offset:10' })
  })

  it.each(['inProgress', 'completed'])(
    'projects native history with the answered runtime interaction when the turn is %s',
    async status => {
      const response = {
        requestId: 0,
        interactionScope: 'turn-1',
        answers: { direction: { answers: ['Complete'] } },
      }
      const question = {
        id: 'request-user-input-0',
        type: 'tool',
        tool_name: 'request_user_input',
        status: 'pending',
        render_payload: {
          kind: 'request_user_input',
          requestId: 0,
          interactionScope: 'turn-1',
          interactionStatus: 'pending',
          questions: [{ id: 'direction', question: 'Continue?' }],
        },
      }
      emit.mockImplementation((_name, _payload, acknowledge) => {
        acknowledge({
          ok: true,
          result: {
            taskId: 'task-1',
            workspacePath: '/work',
            runtime: 'codex',
            running: status === 'inProgress',
            // Native messages do not own the executor's settled answer.
            messages: [{ id: 'native', role: 'assistant', content: 'Done' }],
            turns: [
              {
                id: 'turn-1',
                status,
                items: [
                  { id: question.id, type: 'block', block: question },
                  { id: 'reply', type: 'assistant_text', content: 'Done' },
                ],
              },
              {
                id: 'turn-2',
                status: 'inProgress',
                items: [
                  {
                    id: question.id,
                    type: 'block',
                    block: {
                      ...question,
                      render_payload: { ...question.render_payload, interactionScope: 'turn-2' },
                    },
                  },
                ],
              },
            ],
            runtimeTurns: [
              {
                id: 'turn-1',
                status,
                items: [
                  {
                    id: question.id,
                    type: 'block',
                    block: {
                      ...question,
                      status: 'done',
                      render_payload: {
                        ...question.render_payload,
                        interactionStatus: 'answered',
                        response,
                      },
                    },
                  },
                ],
              },
            ],
            hasMoreBefore: true,
            beforeCursor: 'native-cursor',
          },
        })
      })
      const stream = await createStream(config)
      const transcript = await stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })
      expect(transcript).toMatchObject({ hasMoreBefore: true, beforeCursor: 'native-cursor' })
      const answered = transcript.messages.find(message => message.subtaskId === 'turn-1')
      expect(answered).toMatchObject({
        content: 'Done',
        blocks: [
          {
            status: 'done',
            renderPayload: { interactionStatus: 'answered', response },
          },
        ],
        runtimeItems: [{ id: 'reply', type: 'assistant_text', content: 'Done' }],
      })
      const next = transcript.messages.find(message => message.subtaskId === 'turn-2')
      expect(next?.blocks?.[0]).toMatchObject({
        status: 'pending',
        renderPayload: { interactionStatus: 'pending', interactionScope: 'turn-2' },
      })
    }
  )

  it('loads only the selected device work through the Mac runtime protocol', async () => {
    emit.mockImplementation((name, payload, acknowledge) => {
      expect(name).toBe('runtime:request')
      expect(payload).toMatchObject({
        method: 'runtime.tasks.list',
        device_id: 'device-1',
        timeout_seconds: 75,
        params: {},
      })
      acknowledge({
        ok: true,
        result: {
          workspaces: [
            {
              workspacePath: '/work/Wegent',
              label: 'Wegent',
              tasks: [{ taskId: 'task-1', title: 'Fix loading', runtime: 'codex' }],
            },
          ],
        },
      })
    })
    const stream = await createStream(config)

    await expect(stream.listWork('device-1', 'Mac Studio')).resolves.toMatchObject({
      projects: [
        {
          project: { name: 'Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'device-1',
              deviceName: 'Mac Studio',
              tasks: [{ taskId: 'task-1', workspacePath: '/work/Wegent' }],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
  })

  it('decompresses large transcript acknowledgements', async () => {
    const transcript = {
      taskId: 'task-1',
      workspacePath: '/work',
      runtime: 'codex',
      turns: [],
      runtimeTurns: [],
      messages: [{ id: 'assistant-1', role: 'assistant', content: '历史消息'.repeat(1000) }],
    }
    emit.mockImplementation((_name, _payload, acknowledge) => {
      acknowledge({
        ok: true,
        result: {
          __runtimeRpcEncoding: 'gzip+base64+json',
          payload: base64.encode(gzipSync(strToU8(JSON.stringify(transcript)))),
        },
      })
    })
    const stream = await createStream(config)

    await expect(
      stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })
    ).resolves.toMatchObject(transcript)
  })

  it('retries an oversized five-turn page as one turn with the same cursor', async () => {
    emit
      .mockImplementationOnce((_name, payload, acknowledge) => {
        expect(payload).toMatchObject({
          params: { taskId: 'task-1', limit: 5, beforeCursor: 'offset:15' },
        })
        acknowledge({
          ok: false,
          error: {
            code: 'runtime_rpc_failed',
            message: 'Response exceeded the transport payload limit',
          },
        })
      })
      .mockImplementationOnce((_name, payload, acknowledge) => {
        expect(payload).toMatchObject({
          params: { taskId: 'task-1', limit: 1, beforeCursor: 'offset:15' },
        })
        acknowledge({
          ok: true,
          result: {
            taskId: 'task-1',
            workspacePath: '/work',
            runtime: 'codex',
            turns: [],
            runtimeTurns: [],
            messages: [{ id: 'assistant-1', role: 'assistant', content: 'latest' }],
            beforeCursor: 'offset:14',
          },
        })
      })
    const stream = await createStream(config)

    await expect(
      stream.getTranscript(
        { deviceId: 'device-1', taskId: 'task-1' },
        { beforeCursor: 'offset:15' }
      )
    ).resolves.toMatchObject({
      messages: [{ content: 'latest' }],
      beforeCursor: 'offset:14',
    })
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('rejects a transcript without canonical turns like PC', async () => {
    emit.mockImplementation((_name, _payload, acknowledge) => {
      acknowledge({ ok: true, result: { messages: [] } })
    })
    const stream = await createStream(config)
    await expect(stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })).rejects.toThrow(
      'missing canonical turns'
    )
    expect(emit).toHaveBeenCalledOnce()
  })

  it('surfaces runtime acknowledgement errors', async () => {
    emit.mockImplementation((_name, _payload, acknowledge) => {
      acknowledge({
        ok: false,
        error: { code: 'device_offline', message: 'Executor offline' },
      })
    })
    const stream = await createStream(config)

    await expect(stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })).rejects.toThrow(
      'device_offline: Executor offline'
    )
    expect(emit).toHaveBeenCalledOnce()
  })

  it('uses the Wework runtime relay contract and strictly scopes events', async () => {
    const listener = vi.fn()
    const stream = await createStream(config)
    await stream.subscribe({ deviceId: 'device-1', taskId: 'task-1' }, listener, vi.fn())

    expect(io).toHaveBeenCalledWith(
      'wss://stream.wegent.example/wework-runtime',
      expect.objectContaining({
        path: '/socket.io',
        auth: { token: 'token', client_origin: 'wework' },
      })
    )
    expect(connect).toHaveBeenCalledOnce()

    handlers.get('runtime:event')?.({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        deviceId: 'device-1',
        data: { delta: 'hello' },
      },
    })
    handlers.get('runtime:event')?.({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'other-task',
        deviceId: 'device-1',
        data: { delta: 'ignored' },
      },
    })
    handlers.get('runtime:event')?.({
      event: 'response.output_text.delta',
      payload: { data: { delta: 'unscoped' } },
    })

    expect(listener).toHaveBeenCalledOnce()
  })

  it.each(['cloud', 'remote', 'app'] as const)(
    'projects %s transport IDs before scoping reasoning and text events, as PC does',
    async deviceType => {
      const devices: DeviceInfo[] = [
        {
          id: 1,
          device_id: 'logical-device',
          execution_target_id: deviceType === 'app' ? 'app-record-1' : undefined,
          socket_device_id: 'socket-device',
          runtime_instance_id: 'runtime-instance',
          name: 'Executor',
          device_type: deviceType,
          bind_shell: 'claudecode',
          status: 'online',
        },
      ]
      const listener = vi.fn()
      const lifecycle = vi.fn()
      const stream = await createStream(config, () => devices)
      const target = deviceType === 'app' ? 'app-record-1' : 'logical-device'
      await stream.subscribe({ deviceId: target, taskId: 'task' }, listener, vi.fn())
      stream.subscribeLifecycle(lifecycle, vi.fn())
      for (const [name, data] of [
        ['response.created', {}],
        ['response.reasoning_summary_text.delta', { delta: '检查' }],
        ['response.output_text.delta', { itemId: 'text', delta: '你好' }],
        ['response.completed', {}],
      ] as const) {
        handlers.get('runtime:event')?.({
          event: name,
          payload: {
            deviceId: 'socket-device',
            taskId: 'task',
            subtaskId: 'turn',
            data,
          },
        })
      }
      expect(listener.mock.calls.map(([event]) => event.name)).toEqual([
        'response.created',
        'response.reasoning_summary_text.delta',
        'response.output_text.delta',
        'response.completed',
      ])
      expect(listener.mock.calls[2]![0].payload).toMatchObject({
        deviceId: target,
        data: { delta: '你好' },
      })
      expect(lifecycle.mock.calls[2]![0]).toEqual({ deviceId: target, taskId: 'task' })
    }
  )

  it.each([false, true])(
    'preserves record-specific execution targets when registrations share a runtime (reversed: %s)',
    async reversed => {
      const devices: DeviceInfo[] = [200, 201].map(id => ({
        id,
        device_id: `registration-${id}`,
        execution_target_id: `app-record-${id}`,
        socket_device_id: `app-record-${id}`,
        runtime_instance_id: 'same-installation',
        device_type: 'app',
        name: 'Computer',
        bind_shell: 'claudecode',
        status: 'online',
      }))
      if (reversed) devices.reverse()
      const listener = vi.fn()
      const lifecycle = vi.fn()
      const stream = await createStream(config, () => devices)
      await stream.subscribe({ deviceId: 'app-record-201', taskId: 'task' }, listener, vi.fn())
      stream.subscribeLifecycle(lifecycle, vi.fn())
      const names = ['response.created', 'response.output_text.delta', 'response.completed']
      for (const name of names) {
        handlers.get('runtime:event')?.({
          event: name,
          payload: { deviceId: 'app-record-201', taskId: 'task', data: { delta: 'partial' } },
        })
      }
      expect(listener.mock.calls.map(([event]) => event.name)).toEqual(names)
      expect(lifecycle.mock.calls.map(([address]) => address)).toEqual(
        names.map(() => ({ deviceId: 'app-record-201', taskId: 'task' }))
      )
      handlers.get('runtime:event')?.({
        event: 'response.output_text.delta',
        payload: { deviceId: 'app-record-200', taskId: 'task', data: { delta: 'other' } },
      })
      expect(listener).toHaveBeenCalledTimes(names.length)
      expect(lifecycle).toHaveBeenLastCalledWith(
        { deviceId: 'app-record-200', taskId: 'task' },
        expect.objectContaining({ name: 'response.output_text.delta' })
      )
    }
  )

  it.each([
    { device_id: 'other-computer' },
    { address: { deviceId: 'other-computer' } },
    { address: { device_id: 'other-computer' } },
  ])('preserves PC device field scoping for %j', async deviceFields => {
    const listener = vi.fn()
    const stream = await createStream(config)
    await stream.subscribe({ deviceId: 'selected-computer', taskId: 'task' }, listener, vi.fn())
    handlers.get('runtime:event')?.({
      event: 'response.output_text.delta',
      payload: { taskId: 'task', ...deviceFields, data: { delta: 'private' } },
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('delivers background task events to the global lifecycle listener', async () => {
    const currentListener = vi.fn()
    const lifecycleListener = vi.fn()
    const stream = await createStream(config)
    await stream.subscribe(
      { deviceId: 'device-1', taskId: 'current-task' },
      currentListener,
      vi.fn()
    )
    const unsubscribe = stream.subscribeLifecycle(lifecycleListener, vi.fn())

    handlers.get('runtime:event')?.({
      event: 'response.completed',
      payload: { taskId: 'background-task', deviceId: 'device-1' },
    })

    expect(currentListener).not.toHaveBeenCalled()
    expect(lifecycleListener).toHaveBeenCalledWith(
      { deviceId: 'device-1', taskId: 'background-task' },
      expect.objectContaining({ name: 'response.completed' })
    )

    unsubscribe()
    handlers.get('runtime:event')?.({
      event: 'response.completed',
      payload: { taskId: 'other-task', deviceId: 'device-1' },
    })
    expect(lifecycleListener).toHaveBeenCalledOnce()
  })

  it('never assigns a shared alias to one of two independent installations', async () => {
    const devices: DeviceInfo[] = [1, 2].map(id => ({
      id,
      device_id: `computer-${id}`,
      execution_target_id: `app-record-${id}`,
      runtime_instance_id: `installation-${id}`,
      app_device_id: 'shared-alias',
      name: 'Computer',
      device_type: 'app',
      bind_shell: 'claudecode',
      status: 'online',
    }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const listener = vi.fn()
    const lifecycle = vi.fn()
    const stream = await createStream(config, () => devices)
    await stream.subscribe({ deviceId: 'app-record-1', taskId: 'task' }, listener, vi.fn())
    stream.subscribeLifecycle(lifecycle, vi.fn())
    handlers.get('runtime:event')?.({
      event: 'response.output_text.delta',
      payload: {
        deviceId: 'shared-alias',
        taskId: 'task',
        subtaskId: 'turn',
        data: { delta: 'private' },
      },
    })
    expect(listener).not.toHaveBeenCalled()
    expect(lifecycle).not.toHaveBeenCalled()
    handlers.get('runtime:event')?.({
      event: 'response.output_text.delta',
      payload: {
        deviceId: 'app-record-1',
        taskId: 'task',
        subtaskId: 'turn',
        data: { delta: 'own' },
      },
    })
    expect(listener).toHaveBeenCalledOnce()
    warning.mockRestore()
  })

  it('uses the latest inventory and nested runtime routes without reconnecting', async () => {
    let devices: DeviceInfo[] = []
    const listener = vi.fn()
    const stream = await createStream(config, () => devices)
    await stream.subscribe({ deviceId: 'logical', taskId: 'task' }, listener, vi.fn())
    devices = [
      {
        id: 1,
        device_id: 'logical',
        device_type: 'remote',
        name: 'Remote',
        bind_shell: 'claudecode',
        status: 'online',
        runtime_routes: [
          {
            kind: 'remote-relay',
            device_id: 'old-address',
            runtime_device_id: 'wire-route',
            status: 'online',
          },
        ],
      },
    ]
    handlers.get('runtime:event')?.({
      event: 'response.created',
      payload: {
        deviceId: 'wire-route',
        taskId: 'task',
        subtaskId: 'turn',
      },
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0]![0].payload.deviceId).toBe('logical')
    expect(connect).toHaveBeenCalledOnce()
  })

  it('reloads the canonical transcript after a socket reconnection', async () => {
    const onReconnect = vi.fn()
    const onLifecycleReconnect = vi.fn()
    const onLifecycleEvent = vi.fn()
    const stream = await createStream(config)
    await stream.subscribe({ deviceId: 'device-1', taskId: 'task-1' }, vi.fn(), onReconnect)
    stream.subscribeLifecycle(onLifecycleEvent, onLifecycleReconnect)

    handlers.get('connect')?.()
    handlers.get('connect')?.()
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(onLifecycleReconnect).toHaveBeenCalledOnce()

    stream.dispose()
    expect(disconnect).toHaveBeenCalledOnce()
    handlers.get('runtime:event')?.({
      event: 'response.completed',
      payload: { deviceId: 'device-1', taskId: 'background-task' },
    })
    expect(onLifecycleEvent).not.toHaveBeenCalled()
  })
})
