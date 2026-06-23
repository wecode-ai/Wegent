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
      onReconnect: vi.fn(),
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
      { session_id: 'terminal-1' },
      expect.any(Function)
    )
  })

  test('relays terminal input, resize, and close over Socket.IO', async () => {
    const client = createRemoteTerminalClient('terminal-1')

    await client.write('pwd\r')
    await client.resize(32, 120)
    await client.close()

    expect(emitMock).toHaveBeenCalledWith('terminal:input', {
      session_id: 'terminal-1',
      data: 'pwd\r',
    })
    expect(emitMock).toHaveBeenCalledWith('terminal:resize', {
      session_id: 'terminal-1',
      rows: 32,
      cols: 120,
    })
    expect(emitMock).toHaveBeenCalledWith(
      'terminal:close',
      { session_id: 'terminal-1' },
      expect.any(Function)
    )
  })

  test('subscribes and unsubscribes terminal output handlers', () => {
    const client = createRemoteTerminalClient('terminal-1')
    const handler = vi.fn()

    const unsubscribe = client.onOutput(handler)
    unsubscribe()

    expect(onMock).toHaveBeenCalledWith('terminal:output', handler)
    expect(offMock).toHaveBeenCalledWith('terminal:output', handler)
  })
})
