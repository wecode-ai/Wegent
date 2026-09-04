import { createAuthenticatedSocketClient } from '@wegent/chat-core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getToken } from '@/api/auth'
import { getRuntimeConfig } from '@/config/runtime'
import { createRemoteTerminalClient } from './remote-terminal-socket'

vi.mock('@wegent/chat-core', () => ({
  createAuthenticatedSocketClient: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  getToken: vi.fn(),
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: vi.fn(),
}))

const createAuthenticatedSocketClientMock = vi.mocked(createAuthenticatedSocketClient)
const getTokenMock = vi.mocked(getToken)
const getRuntimeConfigMock = vi.mocked(getRuntimeConfig)

describe('createRemoteTerminalClient', () => {
  const emitMock = vi.fn()
  const onMock = vi.fn()
  const offMock = vi.fn()
  const ensureConnectedMock = vi.fn()
  const disposeMock = vi.fn()
  const onReconnectMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    getTokenMock.mockReturnValue('auth-token')
    getRuntimeConfigMock.mockReturnValue({
      appBasePath: '',
      apiBaseUrl: '/api',
      socketBaseUrl: 'http://socket.example',
      socketPath: '/socket.io',
      loginMode: 'all',
      oidcLoginText: '',
      cloudDeviceScalingWikiUrl: '',
    })
    emitMock.mockImplementation((event, payload, ack) => {
      if (typeof ack === 'function') {
        ack({ success: true })
      }
    })
    createAuthenticatedSocketClientMock.mockReturnValue({
      socket: {
        connected: true,
        emit: emitMock,
        on: onMock,
        off: offMock,
        disconnect: vi.fn(),
      },
      ensureConnected: ensureConnectedMock,
      dispose: disposeMock,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getRawSocket: vi.fn(),
      getState: vi.fn(),
      subscribe: vi.fn(),
      onReconnect: onReconnectMock,
    })
  })

  test('uses the shared authenticated Socket.IO client for the terminal namespace', async () => {
    const client = createRemoteTerminalClient('terminal-1')

    await client.attach()

    expect(createAuthenticatedSocketClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: '/terminal',
        path: '/socket.io',
        getToken,
      })
    )
    const options = createAuthenticatedSocketClientMock.mock.calls[0][0]
    expect(await options.socketBaseUrl()).toBe('http://socket.example')
    expect(ensureConnectedMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(
      'terminal:attach',
      {
        session_id: 'terminal-1',
        consumer_id: expect.any(String),
        last_acked_sequence: 0,
      },
      expect.any(Function)
    )
  })

  test('resumes attach from the last acknowledged output sequence', async () => {
    const client = createRemoteTerminalClient('terminal-1')

    await client.attach(42)

    expect(emitMock).toHaveBeenCalledWith(
      'terminal:attach',
      {
        session_id: 'terminal-1',
        consumer_id: expect.any(String),
        last_acked_sequence: 42,
      },
      expect.any(Function)
    )
  })

  test('uses the injected backend for both the socket URL and authentication', async () => {
    const resolveToken = vi.fn(() => 'connected-backend-token')
    const client = createRemoteTerminalClient('terminal-1', {
      socketBaseUrl: 'http://10.201.3.200:8000',
      socketPath: '/socket.io',
      getToken: resolveToken,
    })

    await client.attach()

    expect(getRuntimeConfigMock).not.toHaveBeenCalled()
    const options = createAuthenticatedSocketClientMock.mock.calls[0][0]
    expect(await options.socketBaseUrl()).toBe('http://10.201.3.200:8000')
    expect(options.path).toBe('/socket.io')
    expect(options.getToken).toBe(resolveToken)
  })

  test('relays terminal acknowledgement, input, resize, and close over Socket.IO', async () => {
    const client = createRemoteTerminalClient('terminal-1')

    await client.ack(7)
    await client.write('pwd\r')
    await client.resize(32, 120)
    await client.close()

    expect(emitMock).toHaveBeenCalledWith(
      'terminal:ack',
      {
        session_id: 'terminal-1',
        consumer_id: expect.any(String),
        sequence: 7,
      },
      expect.any(Function)
    )
    expect(emitMock).toHaveBeenCalledWith('terminal:input', {
      session_id: 'terminal-1',
      consumer_id: expect.any(String),
      data: 'pwd\r',
    })
    expect(emitMock).toHaveBeenCalledWith('terminal:resize', {
      session_id: 'terminal-1',
      consumer_id: expect.any(String),
      rows: 32,
      cols: 120,
    })
    expect(emitMock).toHaveBeenCalledWith(
      'terminal:close',
      {
        session_id: 'terminal-1',
        consumer_id: expect.any(String),
      },
      expect.any(Function)
    )
    expect(new Set(emitMock.mock.calls.map(([, payload]) => payload.consumer_id)).size).toBe(1)
  })

  test('subscribes only to output for its active consumer', async () => {
    const client = createRemoteTerminalClient('terminal-1')
    const handler = vi.fn()

    const unsubscribe = client.onOutput(handler)
    await client.attach()
    const consumerId = emitMock.mock.calls[0][1].consumer_id
    const activeConsumerHandler = onMock.mock.calls[0][1]
    activeConsumerHandler({
      session_id: 'terminal-1',
      consumer_id: 'other-consumer',
      sequence: 1,
      data: 'ignored',
    })
    activeConsumerHandler({
      session_id: 'terminal-1',
      consumer_id: consumerId,
      sequence: 1,
      data: 'accepted',
    })
    unsubscribe()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ data: 'accepted' }))
    expect(offMock).toHaveBeenCalledWith('terminal:output', activeConsumerHandler)
  })

  test('subscribes to authenticated socket reconnects', () => {
    const unsubscribe = vi.fn()
    const handler = vi.fn()
    onReconnectMock.mockReturnValue(unsubscribe)
    const client = createRemoteTerminalClient('terminal-1')

    const result = client.onReconnect(handler)

    expect(onReconnectMock).toHaveBeenCalledWith(handler)
    expect(result).toBe(unsubscribe)
  })

  test('subscribes and unsubscribes socket disconnect handlers', () => {
    const handler = vi.fn()
    const client = createRemoteTerminalClient('terminal-1')

    const unsubscribe = client.onDisconnect(handler)
    unsubscribe()

    expect(onMock).toHaveBeenCalledWith('disconnect', handler)
    expect(offMock).toHaveBeenCalledWith('disconnect', handler)
  })
})
