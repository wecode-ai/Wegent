import { base64 } from '@scure/base'
import { gzipSync, strToU8 } from 'fflate'
import { io } from 'socket.io-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeStream } from './runtimeStream'

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
  const removeAllListeners = vi.fn()

  beforeEach(() => {
    handlers.clear()
    connect.mockClear()
    disconnect.mockClear()
    emit.mockReset()
    removeAllListeners.mockClear()
    vi.mocked(io).mockReturnValue({
      connected: false,
      connect,
      disconnect,
      emit,
      removeAllListeners,
      on: vi.fn((name: string, handler: (payload?: unknown) => void) => {
        handlers.set(name, handler)
      }),
    } as never)
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
          limit: 50,
        },
      })
      acknowledge({
        ok: true,
        result: {
          taskId: 'task-1',
          workspacePath: '/work',
          runtime: 'codex',
          messages: [{ id: 'user-1', role: 'user', content: 'pwd' }],
        },
      })
    })
    const stream = new RuntimeStream(config)

    await expect(
      stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })
    ).resolves.toMatchObject({ taskId: 'task-1', messages: [{ content: 'pwd' }] })
  })

  it('decompresses large transcript acknowledgements', async () => {
    const transcript = {
      taskId: 'task-1',
      workspacePath: '/work',
      runtime: 'codex',
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
    const stream = new RuntimeStream(config)

    await expect(stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })).resolves.toEqual(
      transcript
    )
  })

  it('surfaces runtime acknowledgement errors', async () => {
    emit.mockImplementation((_name, _payload, acknowledge) => {
      acknowledge({
        ok: false,
        error: { code: 'device_offline', message: 'Executor offline' },
      })
    })
    const stream = new RuntimeStream(config)

    await expect(stream.getTranscript({ deviceId: 'device-1', taskId: 'task-1' })).rejects.toThrow(
      'device_offline: Executor offline'
    )
  })

  it('uses the Wework runtime relay contract and strictly scopes events', () => {
    const listener = vi.fn()
    const stream = new RuntimeStream(config)
    stream.subscribe({ deviceId: 'device-1', taskId: 'task-1' }, listener, vi.fn())

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

  it('delivers background task events to the global lifecycle listener', () => {
    const currentListener = vi.fn()
    const lifecycleListener = vi.fn()
    const stream = new RuntimeStream(config)
    stream.subscribe({ deviceId: 'device-1', taskId: 'current-task' }, currentListener, vi.fn())
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

  it('reloads the canonical transcript after a socket reconnection', () => {
    const onReconnect = vi.fn()
    const onLifecycleReconnect = vi.fn()
    const stream = new RuntimeStream(config)
    stream.subscribe({ deviceId: 'device-1', taskId: 'task-1' }, vi.fn(), onReconnect)
    stream.subscribeLifecycle(vi.fn(), onLifecycleReconnect)

    handlers.get('connect')?.()
    handlers.get('connect')?.()
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(onLifecycleReconnect).toHaveBeenCalledOnce()

    stream.dispose()
    expect(removeAllListeners).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
