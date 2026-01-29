// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket client for real-time chat
 */

import { io, Socket } from 'socket.io-client'
import { getServerUrl, getToken } from './client'

export interface ChatMessage {
  message: string
  task_id: number
  attachment_id?: number
}

export interface ChatResponse {
  status: string
  message?: string
  error?: string
}

let socket: Socket | null = null

/**
 * Connect to WebSocket server
 */
export async function connectWebSocket(): Promise<Socket> {
  if (socket?.connected) {
    return socket
  }

  const serverUrl = await getServerUrl()
  const token = await getToken()

  socket = io(serverUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: {
      token: token,
    },
  })

  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Failed to create socket'))
      return
    }

    socket.on('connect', () => {
      resolve(socket!)
    })

    socket.on('connect_error', (error) => {
      reject(error)
    })

    // Set a timeout for connection
    setTimeout(() => {
      if (!socket?.connected) {
        reject(new Error('Connection timeout'))
      }
    }, 10000)
  })
}

/**
 * Disconnect from WebSocket server
 */
export function disconnectWebSocket(): void {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}

/**
 * Send a chat message
 */
export async function sendChatMessage(
  message: ChatMessage,
): Promise<ChatResponse> {
  const socket = await connectWebSocket()

  return new Promise((resolve, reject) => {
    socket.emit('chat:send', message, (response: ChatResponse) => {
      if (response.error) {
        reject(new Error(response.error))
      } else {
        resolve(response)
      }
    })

    // Timeout after 30 seconds
    setTimeout(() => {
      reject(new Error('Message send timeout'))
    }, 30000)
  })
}

/**
 * Get the current socket instance
 */
export function getSocket(): Socket | null {
  return socket
}
