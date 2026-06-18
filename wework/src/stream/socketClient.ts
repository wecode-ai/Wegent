import {
  createSocketClient as createCoreSocketClient,
  type SocketClientSocket,
} from '@wegent/chat-core'
import { getRuntimeConfig } from '@/config/runtime'
import { getToken } from '@/api/auth'

export type WorkbenchSocket = SocketClientSocket

export function createSocketClient(): WorkbenchSocket {
  const { socketBaseUrl, socketPath } = getRuntimeConfig()
  const client = createCoreSocketClient({
    socketBaseUrl: () => socketBaseUrl,
    path: socketPath,
    namespace: '/chat',
    getToken,
    logger: console,
  })

  void client.ensureConnected()
  return client.socket
}
