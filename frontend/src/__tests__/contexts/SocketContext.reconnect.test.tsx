import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { SocketProvider, useSocket } from '@/contexts/SocketContext'

const mockIo = jest.fn()
const mockGetToken = jest.fn()
const mockFetchRuntimeConfig = jest.fn()
const mockReconnectCallback = jest.fn()

jest.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => mockIo(...args),
}))

jest.mock('@/apis/user', () => ({
  getToken: () => mockGetToken(),
  removeToken: jest.fn(),
}))

jest.mock('@/lib/runtime-config', () => ({
  fetchRuntimeConfig: () => mockFetchRuntimeConfig(),
  getSocketUrl: () => 'http://fallback-socket',
}))

function createMockSocket() {
  const socketHandlers = new Map<string, (...args: unknown[]) => void>()
  const socketState = {
    connected: false,
  }
  const emit = jest.fn((event: string, _payload: unknown, ack?: (response: unknown) => void) => {
    if (event === 'task:join' && ack) {
      ack({ subtasks: [] })
    }
  })
  const connect = jest.fn()

  return {
    get connected() {
      return socketState.connected
    },
    emit,
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      socketHandlers.set(event, handler)
    }),
    connect,
    disconnect: jest.fn(),
    io: {
      on: jest.fn(),
    },
    triggerSocket: (event: string, ...args: unknown[]) => {
      if (event === 'connect') socketState.connected = true
      if (event === 'disconnect') socketState.connected = false
      if (event === 'connect_error') socketState.connected = false
      socketHandlers.get(event)?.(...args)
    },
  }
}

function SocketProbe({ onReady }: { onReady: (api: ReturnType<typeof useSocket>) => void }) {
  const socketApi = useSocket()

  React.useEffect(() => {
    onReady(socketApi)
  }, [onReady, socketApi])

  return null
}

describe('SocketProvider reconnect notification', () => {
  let consoleInfoSpy: jest.SpyInstance
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockGetToken.mockReturnValue('token')
    mockFetchRuntimeConfig.mockResolvedValue({ socketDirectUrl: 'http://socket' })
  })

  afterEach(() => {
    consoleInfoSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('notifies reconnect subscribers instead of issuing a raw task join', async () => {
    const socket = createMockSocket()
    mockIo.mockReturnValue(socket)

    let socketApi: ReturnType<typeof useSocket> | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socketApi?.socket).toBe(socket))
    expect(socket.connect).toHaveBeenCalledTimes(1)
    expect(mockIo.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
      })
    )
    socketApi!.onReconnect(mockReconnectCallback)

    await act(async () => {
      socket.triggerSocket('connect')
    })

    await act(async () => {
      await socketApi!.joinTask(2384260)
    })
    expect(socket.emit).toHaveBeenCalledWith(
      'task:join',
      { task_id: 2384260 },
      expect.any(Function)
    )

    socket.emit.mockClear()

    await act(async () => {
      socket.triggerSocket('disconnect', 'transport close')
      socket.triggerSocket('connect')
    })

    expect(mockReconnectCallback).toHaveBeenCalledTimes(1)
    expect(socket.emit).not.toHaveBeenCalledWith(
      'task:join',
      expect.objectContaining({ task_id: 2384260 }),
      expect.any(Function)
    )
  })

  it('notifies reconnect subscribers when the socket connects again after disconnect', async () => {
    const socket = createMockSocket()
    mockIo.mockReturnValue(socket)

    let socketApi: ReturnType<typeof useSocket> | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socketApi?.socket).toBe(socket))
    socketApi!.onReconnect(mockReconnectCallback)

    await act(async () => {
      socket.triggerSocket('connect')
    })
    expect(mockReconnectCallback).not.toHaveBeenCalled()

    await act(async () => {
      socket.triggerSocket('disconnect', 'transport close')
      socket.triggerSocket('connect')
    })

    expect(mockReconnectCallback).toHaveBeenCalledTimes(1)
  })

  it('treats a disconnect as connection history even if the first connect was not observed', async () => {
    const socket = createMockSocket()
    mockIo.mockReturnValue(socket)

    let socketApi: ReturnType<typeof useSocket> | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socketApi?.socket).toBe(socket))
    socketApi!.onReconnect(mockReconnectCallback)

    await act(async () => {
      socket.triggerSocket('disconnect', 'transport close')
      socket.triggerSocket('connect')
    })

    expect(mockReconnectCallback).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh connection attempt when asked to ensure a disconnected socket is connected', async () => {
    const firstSocket = createMockSocket()
    const secondSocket = createMockSocket()
    mockIo.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)

    let socketApi: ReturnType<typeof useSocket> | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socketApi?.socket).toBe(firstSocket))
    socketApi!.onReconnect(mockReconnectCallback)

    await act(async () => {
      firstSocket.triggerSocket('connect')
      firstSocket.triggerSocket('disconnect', 'transport close')
    })

    await act(async () => {
      socketApi!.ensureConnected()
    })

    await waitFor(() => expect(socketApi?.socket).toBe(secondSocket))
    expect(firstSocket.disconnect).toHaveBeenCalledTimes(1)
    expect(mockIo).toHaveBeenCalledTimes(2)
    expect(mockIo.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        autoConnect: false,
        reconnection: false,
        forceNew: true,
        multiplex: false,
        transports: ['websocket'],
      })
    )
    expect(mockIo.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        autoConnect: false,
        reconnection: false,
        forceNew: true,
        multiplex: false,
        transports: ['websocket'],
      })
    )
    expect(secondSocket.connect).toHaveBeenCalledTimes(1)

    await act(async () => {
      secondSocket.triggerSocket('connect')
    })

    expect(mockReconnectCallback).toHaveBeenCalledTimes(1)
  })

  it('recreates a fresh authenticated namespace socket after connect_error', async () => {
    const firstSocket = createMockSocket()
    const secondSocket = createMockSocket()
    mockIo.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)

    let socketApi: ReturnType<typeof useSocket> | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socketApi?.socket).toBe(firstSocket))

    await act(async () => {
      firstSocket.triggerSocket('connect')
      firstSocket.triggerSocket('connect_error', new Error('timeout'))
    })

    expect(firstSocket.connect).toHaveBeenCalledTimes(1)
    expect(mockIo).toHaveBeenCalledTimes(1)
    expect(mockIo.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
      })
    )
    expect(mockIo.mock.calls[0][1]).not.toHaveProperty('query')
    await waitFor(() => expect(socketApi?.connectionError?.message).toBe('timeout'))
    expect(socketApi?.socket?.connected).toBe(false)
    await waitFor(() => expect(socketApi?.reconnectAttempts).toBe(1))

    await waitFor(() => expect(mockIo).toHaveBeenCalledTimes(2), { timeout: 2000 })
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
    expect(secondSocket.connect).toHaveBeenCalledTimes(1)
  })

  it('emits chat cancel without owning ack timeout recovery', async () => {
    const socket = createMockSocket()
    mockIo.mockReturnValue(socket)

    let socketApi: ReturnType<typeof useSocket> | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socketApi?.socket).toBe(socket))

    await act(async () => {
      socket.triggerSocket('connect')
    })

    socket.emit.mockClear()

    await act(async () => {
      await socketApi!.cancelChatStream(77, 'partial', 'Chat')
    })

    expect(socket.emit).toHaveBeenCalledTimes(1)
    const [event, payload, ack] = socket.emit.mock.calls[0]
    expect(event).toBe('chat:cancel')
    expect(payload).toEqual({
      subtask_id: 77,
      partial_content: 'partial',
      shell_type: 'Chat',
    })
    expect(ack).toBeUndefined()
  })
})
