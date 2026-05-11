import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { SocketProvider, useSocket } from '@/contexts/SocketContext'

const mockIo = jest.fn()
const mockGetToken = jest.fn()
const mockFetchRuntimeConfig = jest.fn()
const mockRecoverAll = jest.fn()
const mockIsInitialized = jest.fn()

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

jest.mock('@/features/tasks/state', () => ({
  taskStateManager: {
    isInitialized: () => mockIsInitialized(),
    recoverAll: () => mockRecoverAll(),
  },
}))

function createMockSocket() {
  const socketHandlers = new Map<string, (...args: unknown[]) => void>()
  const managerHandlers = new Map<string, (...args: unknown[]) => void>()
  const emit = jest.fn((event: string, _payload: unknown, ack?: (response: unknown) => void) => {
    if (event === 'task:join' && ack) {
      ack({ subtasks: [] })
    }
  })

  return {
    connected: true,
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
    triggerSocket: (event: string, ...args: unknown[]) => socketHandlers.get(event)?.(...args),
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

describe('SocketProvider reconnect recovery', () => {
  let consoleInfoSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    mockGetToken.mockReturnValue('token')
    mockFetchRuntimeConfig.mockResolvedValue({ socketDirectUrl: 'http://socket' })
    mockIsInitialized.mockReturnValue(true)
    mockRecoverAll.mockResolvedValue(undefined)
  })

  afterEach(() => {
    consoleInfoSpy.mockRestore()
  })

  it('delegates reconnect recovery to TaskStateManager instead of issuing a raw task join', async () => {
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
      await socketApi!.joinTask(2384260)
    })
    expect(socket.emit).toHaveBeenCalledWith('task:join', { task_id: 2384260 }, expect.any(Function))

    socket.emit.mockClear()

    await act(async () => {
      socket.triggerManager('reconnect', 1)
    })

    expect(mockRecoverAll).toHaveBeenCalledTimes(1)
    expect(socket.emit).not.toHaveBeenCalledWith(
      'task:join',
      expect.objectContaining({ task_id: 2384260 }),
      expect.any(Function)
    )
  })
})
