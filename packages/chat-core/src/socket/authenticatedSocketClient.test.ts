import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockIo = vi.hoisted(() => vi.fn())

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

import { createAuthenticatedSocketClient } from './authenticatedSocketClient'

type Handler = (...args: unknown[]) => void

function createMockSocket() {
  const handlers = new Map<string, Set<Handler>>()
  const state = {
    connected: false,
  }

  const socket = {
    get connected() {
      return state.connected
    },
    emit: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? new Set<Handler>()
      eventHandlers.add(handler)
      handlers.set(event, eventHandlers)
      return socket
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler)
      return socket
    }),
    connect: vi.fn(() => socket),
    disconnect: vi.fn(() => {
      state.connected = false
      return socket
    }),
  }

  return {
    socket,
    trigger(event: string, ...args: unknown[]) {
      if (event === 'connect') {
        state.connected = true
      }
      if (event === 'disconnect' || event === 'connect_error') {
        state.connected = false
      }
      handlers.get(event)?.forEach(handler => handler(...args))
    },
  }
}

describe('createAuthenticatedSocketClient', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockIo.mockReset()
  })

  test('creates a manual fresh namespace socket with auth instead of query auth', async () => {
    const rawSocket = createMockSocket()
    mockIo.mockReturnValue(rawSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => 'http://socket',
      path: '/socket.io',
      namespace: '/chat',
      getToken: () => 'token',
    })

    await client.connect()

    expect(mockIo).toHaveBeenCalledWith(
      'http://socket/chat',
      expect.objectContaining({
        path: '/socket.io',
        auth: { token: 'token' },
        autoConnect: false,
        reconnection: false,
        forceNew: true,
        multiplex: false,
        transports: ['websocket'],
        timeout: 20000,
      })
    )
    expect(mockIo.mock.calls[0][1]).not.toHaveProperty('query')
    expect(rawSocket.socket.connect).toHaveBeenCalledTimes(1)
  })

  test('recreates a fresh authenticated socket after connect_error', async () => {
    vi.useFakeTimers()
    const firstSocket = createMockSocket()
    const secondSocket = createMockSocket()
    mockIo.mockReturnValueOnce(firstSocket.socket).mockReturnValueOnce(secondSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => 'http://socket',
      path: '/socket.io',
      namespace: '/chat',
      getToken: () => 'token',
      reconnectDelayMs: () => 10,
    })

    await client.connect()
    firstSocket.trigger('connect')
    firstSocket.trigger('connect_error', new Error('timeout'))

    expect(client.getState().connectionError?.message).toBe('timeout')
    expect(client.getState().reconnectAttempts).toBe(1)

    await vi.runOnlyPendingTimersAsync()

    expect(mockIo).toHaveBeenCalledTimes(2)
    expect(mockIo.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        auth: { token: 'token' },
        autoConnect: false,
        reconnection: false,
        forceNew: true,
        multiplex: false,
        transports: ['websocket'],
      })
    )
    expect(mockIo.mock.calls[1][1]).not.toHaveProperty('query')
    expect(secondSocket.socket.connect).toHaveBeenCalledTimes(1)
  })

  test('keeps facade event handlers bound when a fresh socket replaces the old one', async () => {
    vi.useFakeTimers()
    const firstSocket = createMockSocket()
    const secondSocket = createMockSocket()
    mockIo.mockReturnValueOnce(firstSocket.socket).mockReturnValueOnce(secondSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => 'http://socket',
      path: '/socket.io',
      namespace: '/chat',
      getToken: () => 'token',
      reconnectDelayMs: () => 10,
    })
    const handler = vi.fn()

    client.socket.on('chat:start', handler)
    await client.connect()
    firstSocket.trigger('connect')
    firstSocket.trigger('connect_error', new Error('timeout'))

    await vi.runOnlyPendingTimersAsync()
    secondSocket.trigger('chat:start', { message: 'ready' })

    expect(firstSocket.socket.on).toHaveBeenCalledWith('chat:start', handler)
    expect(secondSocket.socket.on).toHaveBeenCalledWith('chat:start', handler)
    expect(handler).toHaveBeenCalledWith({ message: 'ready' })
  })

  test('does not create a socket when disconnected during pending connect resolution', async () => {
    let resolveBaseUrl!: (value: string) => void
    const socketBaseUrl = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolveBaseUrl = resolve
        })
    )
    const rawSocket = createMockSocket()
    mockIo.mockReturnValue(rawSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl,
      path: '/socket.io',
      namespace: '/chat',
      getToken: () => 'token',
    })

    const pendingConnect = client.connect()
    client.disconnect()
    resolveBaseUrl('http://socket')
    await pendingConnect

    expect(mockIo).not.toHaveBeenCalled()
    expect(rawSocket.socket.connect).not.toHaveBeenCalled()
    expect(client.getState().socket).toBeNull()
  })

  test('clears stale connection errors on intentional disconnect', async () => {
    const rawSocket = createMockSocket()
    mockIo.mockReturnValue(rawSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => 'http://socket',
      path: '/socket.io',
      namespace: '/chat',
      getToken: () => 'token',
    })

    await client.connect()
    rawSocket.trigger('connect_error', new Error('timeout'))
    expect(client.getState().connectionError?.message).toBe('timeout')

    client.disconnect()

    expect(client.getState().connectionError).toBeNull()
  })
})
