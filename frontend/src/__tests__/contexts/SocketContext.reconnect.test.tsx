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
  const managerHandlers = new Map<string, (...args: unknown[]) => void>()
  const socketState = {
    connected: false,
  }
  const emit = jest.fn((event: string, _payload: unknown, ack?: (response: unknown) => void) => {
    if (event === 'task:join' && ack) {
      ack({ subtasks: [] })
    }
  })

  return {
    get connected() {
      return socketState.connected
    },
    emit,
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      socketHandlers.set(event, handler)
    }),
    disconnect: jest.fn(),
    io: {
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        managerHandlers.set(event, handler)
      }),
    },
    triggerSocket: (event: string, ...args: unknown[]) => {
      if (event === 'connect') socketState.connected = true
      if (event === 'disconnect') socketState.connected = false
      socketHandlers.get(event)?.(...args)
    },
    triggerManager: (event: string, ...args: unknown[]) => managerHandlers.get(event)?.(...args),
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

  beforeEach(() => {
    jest.clearAllMocks()
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    mockGetToken.mockReturnValue('token')
    mockFetchRuntimeConfig.mockResolvedValue({ socketDirectUrl: 'http://socket' })
  })

  afterEach(() => {
    consoleInfoSpy.mockRestore()
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
      socket.triggerManager('reconnect', 1)
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

  describe('cancelChatStream timeout', () => {
    afterEach(() => {
      jest.useRealTimers()
    })

    it('resolves with timeout error when ack callback is never invoked', async () => {
      jest.useFakeTimers()
      const socket = createMockSocket()
      const pendingEmits: Array<{
        event: string
        payload: unknown
        ack: (response: unknown) => void
      }> = []

      socket.emit.mockImplementation(
        (event: string, payload: unknown, ack?: (response: unknown) => void) => {
          if (event === 'task:join' && ack) {
            ack({ subtasks: [] })
          } else if (event === 'chat:cancel' && ack) {
            pendingEmits.push({ event, payload, ack })
          }
        }
      )

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

      let result: { success: boolean; error?: string } | undefined
      act(() => {
        void socketApi!.cancelChatStream(42, 'partial', 'Chat').then(r => {
          result = r
        })
      })

      expect(pendingEmits.length).toBe(1)

      act(() => {
        jest.advanceTimersByTime(10_000)
      })

      await waitFor(() => expect(result).toBeDefined())
      expect(result!.success).toBe(false)
      expect(result!.error).toContain('timed out')

      jest.useRealTimers()
    })

    it('resolves with ack response when callback fires before timeout', async () => {
      jest.useFakeTimers()
      const socket = createMockSocket()

      socket.emit.mockImplementation(
        (event: string, payload: unknown, ack?: (response: unknown) => void) => {
          if (event === 'task:join' && ack) {
            ack({ subtasks: [] })
          } else if (event === 'chat:cancel' && ack) {
            ack({ success: true })
          }
        }
      )

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

      let result: { success: boolean; error?: string } | undefined
      await act(async () => {
        result = await socketApi!.cancelChatStream(42, 'partial', 'Chat')
      })

      expect(result!.success).toBe(true)

      jest.useRealTimers()
    })

    it('ignores late ack after timeout already resolved', async () => {
      jest.useFakeTimers()
      const socket = createMockSocket()
      const pendingAcks: Array<(response: unknown) => void> = []

      socket.emit.mockImplementation(
        (event: string, payload: unknown, ack?: (response: unknown) => void) => {
          if (event === 'task:join' && ack) {
            ack({ subtasks: [] })
          } else if (event === 'chat:cancel' && ack) {
            pendingAcks.push(ack)
          }
        }
      )

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

      let result: { success: boolean; error?: string } | undefined
      act(() => {
        void socketApi!.cancelChatStream(42, 'partial', 'Chat').then(r => {
          result = r
        })
      })

      act(() => {
        jest.advanceTimersByTime(10_000)
      })

      await waitFor(() => expect(result).toBeDefined())
      expect(result!.success).toBe(false)

      act(() => {
        pendingAcks[0]({ success: true })
      })

      expect(result!.success).toBe(false)

      jest.useRealTimers()
    })

    it('resolves success=false when ack returns success:false', async () => {
      const socket = createMockSocket()

      socket.emit.mockImplementation(
        (event: string, payload: unknown, ack?: (response: unknown) => void) => {
          if (event === 'task:join' && ack) {
            ack({ subtasks: [] })
          } else if (event === 'chat:cancel' && ack) {
            ack({ success: false, error: 'cancel failed' })
          }
        }
      )

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

      let result: { success: boolean; error?: string } | undefined
      await act(async () => {
        result = await socketApi!.cancelChatStream(42, 'partial', 'Chat')
      })

      expect(result!.success).toBe(false)
      expect(result!.error).toBe('cancel failed')
    })

    it('resolves success=false when ack returns error without success field', async () => {
      const socket = createMockSocket()

      socket.emit.mockImplementation(
        (event: string, payload: unknown, ack?: (response: unknown) => void) => {
          if (event === 'task:join' && ack) {
            ack({ subtasks: [] })
          } else if (event === 'chat:cancel' && ack) {
            ack({ error: 'cancel rejected' })
          }
        }
      )

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

      let result: { success: boolean; error?: string } | undefined
      await act(async () => {
        result = await socketApi!.cancelChatStream(42, 'partial', 'Chat')
      })

      expect(result!.success).toBe(false)
      expect(result!.error).toBe('cancel rejected')
    })
  })
})
