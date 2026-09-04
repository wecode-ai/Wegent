import { createAuthenticatedSocketClient, type AuthenticatedSocketClient } from '@wegent/chat-core'
import { getToken } from '@/api/auth'
import { getRuntimeConfig } from '@/config/runtime'

const TERMINAL_NAMESPACE = '/terminal'
const ACK_TIMEOUT_MS = 10_000

export interface RemoteTerminalOutputPayload {
  session_id: string
  consumer_id: string
  sequence: number
  data: string
}

export interface RemoteTerminalExitPayload {
  session_id: string
  consumer_id: string
  exit_code?: number | null
}

interface TerminalAck {
  success?: boolean
  error?: string
}

export interface RemoteTerminalClient {
  attach: (lastAcknowledgedSequence?: number) => Promise<void>
  ack: (sequence: number) => Promise<void>
  write: (data: string) => Promise<void>
  resize: (rows: number, cols: number) => Promise<void>
  close: () => Promise<void>
  onOutput: (handler: (payload: RemoteTerminalOutputPayload) => void) => () => void
  onExit: (handler: (payload: RemoteTerminalExitPayload) => void) => () => void
  onDisconnect: (handler: () => void) => () => void
  onReconnect: (handler: () => void) => () => void
  dispose: () => void
}

export interface RemoteTerminalClientOptions {
  socketBaseUrl: string
  socketPath: string
  getToken: () => string | null
}

export type RemoteTerminalClientFactory = (sessionId: string) => RemoteTerminalClient

export function createRemoteTerminalClient(
  sessionId: string,
  options?: RemoteTerminalClientOptions
): RemoteTerminalClient {
  const config = options ?? {
    socketBaseUrl: getRuntimeConfig().socketBaseUrl,
    socketPath: getRuntimeConfig().socketPath,
    getToken,
  }
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => config.socketBaseUrl,
    path: config.socketPath,
    namespace: TERMINAL_NAMESPACE,
    getToken: config.getToken,
    authErrorEvent: 'auth_error',
    logger: console,
  })
  const consumerId = crypto.randomUUID()
  const terminalPayload = (payload: Record<string, unknown>) => ({
    session_id: sessionId,
    consumer_id: consumerId,
    ...payload,
  })

  return {
    attach: (lastAcknowledgedSequence = 0) =>
      emitWithAck(
        client,
        'terminal:attach',
        terminalPayload({
          last_acked_sequence: lastAcknowledgedSequence,
        })
      ),
    ack: (sequence: number) => emitWithAck(client, 'terminal:ack', terminalPayload({ sequence })),
    async write(data: string) {
      if (!client.socket.connected) {
        throw new Error('Terminal socket is disconnected')
      }
      client.socket.emit('terminal:input', terminalPayload({ data }))
    },
    async resize(rows: number, cols: number) {
      await client.ensureConnected()
      client.socket.emit('terminal:resize', terminalPayload({ rows, cols }))
    },
    close: () => emitWithAck(client, 'terminal:close', terminalPayload({})),
    onOutput(handler: (payload: RemoteTerminalOutputPayload) => void) {
      const activeConsumerHandler = (payload: RemoteTerminalOutputPayload) => {
        if (payload.consumer_id === consumerId) handler(payload)
      }
      client.socket.on('terminal:output', activeConsumerHandler)
      return () => client.socket.off('terminal:output', activeConsumerHandler)
    },
    onExit(handler: (payload: RemoteTerminalExitPayload) => void) {
      const activeConsumerHandler = (payload: RemoteTerminalExitPayload) => {
        if (payload.consumer_id === consumerId) handler(payload)
      }
      client.socket.on('terminal:exit', activeConsumerHandler)
      return () => client.socket.off('terminal:exit', activeConsumerHandler)
    },
    onDisconnect(handler: () => void) {
      client.socket.on('disconnect', handler)
      return () => client.socket.off('disconnect', handler)
    },
    onReconnect(handler: () => void) {
      return client.onReconnect(handler)
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
