// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Socket.IO Context Provider
 *
 * Manages Socket.IO connection at the application level.
 * Provides connection state and socket instance to child components.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react'
import { io, Socket } from 'socket.io-client'

// Get the API URL from environment
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const SOCKETIO_PATH = '/socket.io'

interface SocketContextType {
  /** Socket.IO instance */
  socket: Socket | null
  /** Whether connected to server */
  isConnected: boolean
  /** Connection error if any */
  connectionError: Error | null
  /** Reconnect attempt count */
  reconnectAttempts: number
  /** Connect to Socket.IO server */
  connect: (token: string) => void
  /** Disconnect from server */
  disconnect: () => void
  /** Join a task room */
  joinTask: (taskId: number) => Promise<{
    streaming?: {
      subtask_id: number
      offset: number
      cached_content: string
    }
    error?: string
  }>
  /** Leave a task room */
  leaveTask: (taskId: number) => void
}

const SocketContext = createContext<SocketContextType | undefined>(undefined)

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [connectionError, setConnectionError] = useState<Error | null>(null)
  const [reconnectAttempts, setReconnectAttempts] = useState(0)

  // Track current joined tasks
  const joinedTasksRef = useRef<Set<number>>(new Set())

  /**
   * Connect to Socket.IO server
   */
  const connect = useCallback((token: string) => {
    if (socket?.connected) {
      return
    }

    // Disconnect existing socket if any
    if (socket) {
      socket.disconnect()
    }

    // Create new socket connection
    const newSocket = io(API_URL + '/chat', {
      path: SOCKETIO_PATH,
      auth: { token },
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling'],
    })

    // Connection event handlers
    newSocket.on('connect', () => {
      console.log('[Socket.IO] Connected:', newSocket.id)
      setIsConnected(true)
      setConnectionError(null)
      setReconnectAttempts(0)
    })

    newSocket.on('disconnect', (reason) => {
      console.log('[Socket.IO] Disconnected:', reason)
      setIsConnected(false)
    })

    newSocket.on('connect_error', (error) => {
      console.error('[Socket.IO] Connection error:', error)
      setConnectionError(error)
      setIsConnected(false)
    })

    newSocket.io.on('reconnect_attempt', (attempt) => {
      console.log('[Socket.IO] Reconnect attempt:', attempt)
      setReconnectAttempts(attempt)
    })

    newSocket.io.on('reconnect', (attempt) => {
      console.log('[Socket.IO] Reconnected after', attempt, 'attempts')
      setIsConnected(true)
      setConnectionError(null)
      setReconnectAttempts(0)

      // Rejoin all previously joined task rooms
      joinedTasksRef.current.forEach((taskId) => {
        newSocket.emit('task:join', { task_id: taskId })
      })
    })

    newSocket.io.on('reconnect_error', (error) => {
      console.error('[Socket.IO] Reconnect error:', error)
      setConnectionError(error)
    })

    setSocket(newSocket)
  }, [socket])

  /**
   * Disconnect from server
   */
  const disconnect = useCallback(() => {
    if (socket) {
      socket.disconnect()
      setSocket(null)
      setIsConnected(false)
      joinedTasksRef.current.clear()
    }
  }, [socket])

  /**
   * Join a task room
   */
  const joinTask = useCallback(
    async (taskId: number): Promise<{
      streaming?: {
        subtask_id: number
        offset: number
        cached_content: string
      }
      error?: string
    }> => {
      if (!socket?.connected) {
        return { error: 'Not connected' }
      }

      return new Promise((resolve) => {
        socket.emit('task:join', { task_id: taskId }, (response: {
          streaming?: {
            subtask_id: number
            offset: number
            cached_content: string
          }
          error?: string
        }) => {
          if (!response.error) {
            joinedTasksRef.current.add(taskId)
          }
          resolve(response)
        })
      })
    },
    [socket]
  )

  /**
   * Leave a task room
   */
  const leaveTask = useCallback(
    (taskId: number) => {
      if (socket?.connected) {
        socket.emit('task:leave', { task_id: taskId })
        joinedTasksRef.current.delete(taskId)
      }
    },
    [socket]
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (socket) {
        socket.disconnect()
      }
    }
  }, [socket])

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        connectionError,
        reconnectAttempts,
        connect,
        disconnect,
        joinTask,
        leaveTask,
      }}
    >
      {children}
    </SocketContext.Provider>
  )
}

/**
 * Hook to use socket context
 */
export function useSocket(): SocketContextType {
  const context = useContext(SocketContext)
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider')
  }
  return context
}

/**
 * Hook to auto-connect socket when token is available
 */
export function useSocketAutoConnect(token: string | null) {
  const { connect, disconnect, isConnected } = useSocket()

  useEffect(() => {
    if (token && !isConnected) {
      connect(token)
    }
    return () => {
      // Don't disconnect on cleanup - let the provider manage lifecycle
    }
  }, [token, connect, isConnected])
}
