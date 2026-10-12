import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
  afterEach(() => vi.useRealTimers())
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
        tryAllTransports: true,
        timeout: 20000,
      })
    )
    expect(mockIo.mock.calls[0][1]).not.toHaveProperty('query')
    expect(rawSocket.socket.connect).toHaveBeenCalledTimes(1)
  })

  test('merges custom socket auth metadata with token auth', async () => {
    const rawSocket = createMockSocket()
    mockIo.mockReturnValue(rawSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => 'http://socket',
      path: '/socket.io',
      namespace: '/chat',
      getToken: () => 'token',
      auth: { client_origin: 'wework' },
    })

    await client.connect()

    expect(mockIo).toHaveBeenCalledWith(
      'http://socket/chat',
      expect.objectContaining({
        auth: { client_origin: 'wework', token: 'token' },
      })
    )
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
        tryAllTransports: true,
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

  test('waits for the namespace connection before allowing a request', async () => {
    const rawSocket = createMockSocket()
    mockIo.mockReturnValue(rawSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => 'http://socket',
      path: '/socket.io',
      getToken: () => 'token',
    })
    let settled = false

    const connection = client.ensureConnected().then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(rawSocket.socket.connect).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)

    rawSocket.trigger('connect')
    await connection
    expect(settled).toBe(true)
  })

  test('reports a connection error instead of waiting for an RPC acknowledgement', async () => {
    const rawSocket = createMockSocket()
    mockIo.mockReturnValue(rawSocket.socket)
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => 'http://socket',
      path: '/socket.io',
      getToken: () => 'token',
    })

    const connection = client.ensureConnected()
    await vi.waitFor(() => expect(rawSocket.socket.connect).toHaveBeenCalledTimes(1))
    rawSocket.trigger('connect_error', new Error('WebSocket handshake failed'))

    await expect(connection).rejects.toThrow('WebSocket handshake failed')
    client.dispose()
  })

  test('rejects immediately without a token and can recover after login', async () => {
    vi.useFakeTimers()
    let token: string | null = null
    const raw = createMockSocket()
    mockIo.mockReturnValue(raw.socket)
    const socketBaseUrl = vi.fn(() => 'http://socket')
    const client = createAuthenticatedSocketClient({
      socketBaseUrl,
      getToken: () => token,
    })

    await expect(client.ensureConnected()).rejects.toThrow('authentication token')
    expect(vi.getTimerCount()).toBe(0)
    expect(socketBaseUrl).not.toHaveBeenCalled()
    expect(mockIo).not.toHaveBeenCalled()
    token = 'token'
    const recovery = client.ensureConnected()
    await Promise.resolve()
    await Promise.resolve()
    raw.trigger('connect')
    await recovery
    client.dispose()
  })

  test.each(['connect', 'connect_error', 'resolver_error'])(
    'shares an async recovery attempt and observes its own %s result',
    async outcome => {
      vi.useFakeTimers()
      const first = createMockSocket()
      const recovered = createMockSocket()
      mockIo.mockReturnValueOnce(first.socket).mockReturnValueOnce(recovered.socket)
      let resolveUrl!: (value: string) => void
      let rejectUrl!: (reason: Error) => void
      const socketBaseUrl = vi
        .fn()
        .mockResolvedValueOnce('http://socket')
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve, reject) => {
              resolveUrl = resolve
              rejectUrl = reject
            })
        )
      const client = createAuthenticatedSocketClient({
        socketBaseUrl,
        getToken: () => 'token',
      })
      await client.connect()
      first.trigger('connect_error', new Error('old failure'))

      const firstWait = client.ensureConnected()
      const secondWait = client.ensureConnected()
      const waits = Promise.allSettled([firstWait, secondWait])
      await Promise.resolve()
      expect(client.getState().connectionError).toBeNull()
      expect(socketBaseUrl).toHaveBeenCalledTimes(2)
      // Events from the retired socket cannot fail the URL resolution.
      first.trigger('connect_error', new Error('late old failure'))
      if (outcome === 'resolver_error') {
        rejectUrl(new Error('new resolver failure'))
      } else {
        resolveUrl('http://recovered')
        await Promise.resolve()
        recovered.trigger(outcome, new Error('new handshake failure'))
      }
      const results = await waits
      for (const result of results) {
        if (outcome === 'connect') expect(result.status).toBe('fulfilled')
        else {
          expect(result.status).toBe('rejected')
          if (result.status === 'rejected') {
            expect(result.reason.message).toBe(
              outcome === 'resolver_error' ? 'new resolver failure' : 'new handshake failure'
            )
          }
        }
      }
      client.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  test('times out an unresolved URL and cancels waiters on disconnect', async () => {
    vi.useFakeTimers()
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => new Promise<string>(() => {}),
      getToken: () => 'token',
      timeout: 25,
    })
    const timeout = expect(client.ensureConnected()).rejects.toThrow('timed out after 25ms')
    await vi.advanceTimersByTimeAsync(25)
    await timeout
    const cancelled = expect(client.ensureConnected()).rejects.toThrow('cancelled')
    client.disconnect()
    await cancelled
    expect(vi.getTimerCount()).toBe(0)
  })
})
