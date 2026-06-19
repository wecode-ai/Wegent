import { createAuthenticatedSocketClient, type AuthenticatedSocketClient } from '@wegent/chat-core'
import { getToken } from '@/api/auth'
import { getRuntimeConfig } from '@/config/runtime'

const TERMINAL_NAMESPACE = '/terminal'
const ACK_TIMEOUT_MS = 10_000

export interface RemoteTerminalOutputPayload {
  session_id: string
  data: string
}

export interface RemoteTerminalExitPayload {
  session_id: string
  exit_code?: number | null
}

interface TerminalAck {
  success?: boolean
  error?: string
}

export interface RemoteTerminalClient {
  attach: () => Promise<void>
  write: (data: string) => Promise<void>
  resize: (rows: number, cols: number) => Promise<void>
  close: () => Promise<void>
  onOutput: (handler: (payload: RemoteTerminalOutputPayload) => void) => () => void
  onExit: (handler: (payload: RemoteTerminalExitPayload) => void) => () => void
  dispose: () => void
}

export function createRemoteTerminalClient(sessionId: string): RemoteTerminalClient {
  const config = getRuntimeConfig()
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => config.socketBaseUrl,
    path: config.socketPath,
    namespace: TERMINAL_NAMESPACE,
    getToken,
    authErrorEvent: 'auth_error',
    logger: console,
  })

  return {
    attach: () => emitWithAck(client, 'terminal:attach', { session_id: sessionId }),
    async write(data: string) {
      await client.ensureConnected()
      client.socket.emit('terminal:input', { session_id: sessionId, data })
    },
    async resize(rows: number, cols: number) {
      await client.ensureConnected()
      client.socket.emit('terminal:resize', { session_id: sessionId, rows, cols })
    },
    close: () => emitWithAck(client, 'terminal:close', { session_id: sessionId }),
    onOutput(handler: (payload: RemoteTerminalOutputPayload) => void) {
      client.socket.on('terminal:output', handler)
      return () => client.socket.off('terminal:output', handler)
    },
    onExit(handler: (payload: RemoteTerminalExitPayload) => void) {
      client.socket.on('terminal:exit', handler)
      return () => client.socket.off('terminal:exit', handler)
    },
    dispose() {
      client.dispose()
    },
  }
}

async function emitWithAck(
  client: AuthenticatedSocketClient,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.ensureConnected()
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`${event} timed out`))
    }, ACK_TIMEOUT_MS)

    client.socket.emit(event, payload, (ack: TerminalAck | undefined) => {
      window.clearTimeout(timeout)
      if (ack?.error) {
        reject(new Error(ack.error))
        return
      }
      resolve()
    })
  })
}
