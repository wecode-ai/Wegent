import { io, type Socket } from 'socket.io-client'
import { getRuntimeConfig } from '@/config/runtime'
import { getToken } from '@/api/auth'

export type WorkbenchSocket = Pick<Socket, 'emit' | 'on' | 'off' | 'disconnect' | 'connected'>

export function createSocketClient(): Socket {
  const { socketBaseUrl } = getRuntimeConfig()
  const token = getToken()

  return io(`${socketBaseUrl}/chat`, {
    path: '/socket.io',
    auth: { token },
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket', 'polling'],
    timeout: 20000,
  })
}
