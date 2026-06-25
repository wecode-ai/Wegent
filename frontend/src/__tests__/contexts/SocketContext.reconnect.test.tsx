import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import path from 'path'

type SocketContextModule = typeof import('@/contexts/SocketContext')
type SocketApi = ReturnType<SocketContextModule['useSocket']>

const mockIo = jest.fn()
const mockGetToken = jest.fn()
const mockFetchRuntimeConfig = jest.fn()
const mockReconnectCallback = jest.fn()

const socketIoMockFactory = () => ({
  io: (...args: unknown[]) => mockIo(...args),
})

jest.doMock('socket.io-client', socketIoMockFactory)
jest.doMock(
  require.resolve('socket.io-client', {
    paths: [path.join(process.cwd(), '../packages/chat-core')],
  }),
  socketIoMockFactory
)

jest.mock('@/apis/user', () => ({
  getToken: () => mockGetToken(),
  removeToken: jest.fn(),
}))

jest.mock('@/lib/runtime-config', () => ({
  fetchRuntimeConfig: () => mockFetchRuntimeConfig(),
  getSocketUrl: () => 'http://fallback-socket',
}))

const { SocketProvider, useSocket }: SocketContextModule = require('@/contexts/SocketContext')

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
    off: jest.fn((event: string, handler?: (...args: unknown[]) => void) => {
      if (!handler) {
        socketHandlers.delete(event)
        return
      }
      const currentHandler = socketHandlers.get(event)
      if (currentHandler === handler) {
        socketHandlers.delete(event)
      }
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

function SocketProbe({ onReady }: { onReady: (api: SocketApi) => void }) {
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

    let socketApi: SocketApi | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1))
    expect(socketApi).toBeDefined()
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

    let socketApi: SocketApi | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1))
    expect(socketApi).toBeDefined()
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

    let socketApi: SocketApi | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1))
    expect(socketApi).toBeDefined()
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

    let socketApi: SocketApi | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(firstSocket.connect).toHaveBeenCalledTimes(1))
    expect(socketApi).toBeDefined()
    socketApi!.onReconnect(mockReconnectCallback)

    await act(async () => {
      firstSocket.triggerSocket('connect')
      firstSocket.triggerSocket('disconnect', 'transport close')
    })

    await act(async () => {
      socketApi!.ensureConnected()
    })

    await waitFor(() => expect(mockIo).toHaveBeenCalledTimes(2))
    expect(firstSocket.disconnect).toHaveBeenCalledTimes(1)
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

  it('replays cached chat status to handlers registered after task join', async () => {
    const socket = createMockSocket()
    socket.emit.mockImplementation(
      (event: string, _payload: unknown, ack?: (response: unknown) => void) => {
        if (event === 'task:join' && ack) {
          ack({
            subtasks: [],
            status_updated: {
              task_id: 2384260,
              subtask_id: 77,
              phase: 'summary_compact',
              context_metrics: {
                context_window: 262144,
                reserved_output_tokens: 26214,
                available_input_tokens: 235930,
                used_input_tokens: 108473,
                remaining_input_tokens: 127457,
                remaining_percent: 54,
                display_remaining_tokens: 153671,
                display_remaining_percent: 59,
                trigger_limit: 100000,
                target_limit: 99999,
                is_over_trigger: true,
              },
              context_compaction: {
                type: 'summary_compact',
                status: 'started',
                before_tokens: 108473,
                trigger_limit: 100000,
                target_limit: 99999,
                used_legacy_fallback: false,
                created_at: '2026-06-23T14:55:34Z',
              },
            },
          })
        }
      }
    )
    mockIo.mockReturnValue(socket)

    let socketApi: SocketApi | undefined
    const statusHandler = jest.fn()
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1))
    expect(socketApi).toBeDefined()

    await act(async () => {
      socket.triggerSocket('connect')
      await socketApi!.joinTask(2384260)
    })

    const cleanup = socketApi!.registerChatHandlers({
      onChatStatusUpdated: statusHandler,
    })

    expect(statusHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 2384260,
        phase: 'summary_compact',
        context_compaction: expect.objectContaining({
          status: 'started',
        }),
      })
    )

    cleanup()
  })

  it('recreates a fresh authenticated namespace socket after connect_error', async () => {
    const firstSocket = createMockSocket()
    const secondSocket = createMockSocket()
    mockIo.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)

    let socketApi: SocketApi | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(firstSocket.connect).toHaveBeenCalledTimes(1))
    expect(socketApi).toBeDefined()

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

    let socketApi: SocketApi | undefined
    render(
      <SocketProvider>
        <SocketProbe
          onReady={api => {
            socketApi = api
          }}
        />
      </SocketProvider>
    )

    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1))
    expect(socketApi).toBeDefined()

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
