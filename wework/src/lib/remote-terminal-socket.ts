import { createAuthenticatedSocketClient, type AuthenticatedSocketClient } from '@wegent/chat-core'
import { getToken } from '@/api/auth'
import { getRuntimeConfig } from '@/config/runtime'

const TERMINAL_NAMESPACE = '/terminal'
const ACK_TIMEOUT_MS = 10_000
const MAX_ATTACH_OUTPUT_CHARACTERS = 1024 * 1024
const MAX_ATTACH_EVENTS = 256
type TerminalProtocolVersion = 1 | 2

export interface RemoteTerminalOutputPayload {
  session_id: string
  consumer_id: string
  sequence: number
  data: string
  protocol_version?: TerminalProtocolVersion
}

export interface RemoteTerminalExitPayload {
  session_id: string
  consumer_id: string
  exit_code?: number | null
}

interface TerminalAck {
  success?: boolean
  error?: string
  protocol_version?: TerminalProtocolVersion
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
  let protocolVersion: TerminalProtocolVersion | null = null
  let negotiating = false
  let disposed = false
  let legacySequence = 0
  let pendingCharacters = 0
  let negotiationError: Error | null = null
  const pendingEvents: Array<{ event: 'output' | 'exit'; payload: Record<string, unknown> }> = []
  const outputHandlers = new Set<(payload: RemoteTerminalOutputPayload) => void>()
  const exitHandlers = new Set<(payload: RemoteTerminalExitPayload) => void>()
  const terminalPayload = (payload: Record<string, unknown>) => ({
    session_id: sessionId,
    ...(protocolVersion !== 1 ? { consumer_id: consumerId } : {}),
    ...payload,
  })

  const dispatch = (event: 'output' | 'exit', payload: Record<string, unknown>) => {
    if (payload.protocol_version !== undefined && payload.protocol_version !== protocolVersion) {
      return
    }
    if (protocolVersion === 2) {
      if (payload.consumer_id !== consumerId) return
      if (event === 'output') {
        if (!Number.isSafeInteger(payload.sequence) || (payload.sequence as number) <= 0) return
        outputHandlers.forEach(handler =>
          handler(payload as unknown as RemoteTerminalOutputPayload)
        )
      } else {
        exitHandlers.forEach(handler => handler(payload as unknown as RemoteTerminalExitPayload))
      }
      return
    }
    // A legacy stream has no wire sequence or browser-consumption ACK. The local
    // index only feeds the same ordered xterm queue; it must never be sent upstream.
    if ('consumer_id' in payload || 'sequence' in payload) return
    if (event === 'output') {
      const output: RemoteTerminalOutputPayload = {
        session_id: sessionId,
        consumer_id: consumerId,
        sequence: ++legacySequence,
        data: payload.data as string,
        protocol_version: 1,
      }
      outputHandlers.forEach(handler => handler(output))
    } else {
      exitHandlers.forEach(handler =>
        handler({ ...payload, session_id: sessionId, consumer_id: consumerId })
      )
    }
  }

  const receive = (event: 'output' | 'exit', payload: Record<string, unknown>) => {
    if (disposed || !payload || payload.session_id !== sessionId) return
    if (event === 'output' && typeof payload.data !== 'string') return
    if (negotiating) {
      if (negotiationError) return
      const characters = typeof payload.data === 'string' ? payload.data.length : 0
      if (
        pendingEvents.length >= MAX_ATTACH_EVENTS ||
        pendingCharacters + characters > MAX_ATTACH_OUTPUT_CHARACTERS
      ) {
        negotiationError = new Error('Terminal output exceeded the bounded attach buffer')
        pendingEvents.length = 0
        pendingCharacters = 0
        return
      }
      pendingEvents.push({ event, payload })
      pendingCharacters += characters
    } else if (protocolVersion !== null) {
      dispatch(event, payload)
    }
  }
  const receiveOutput = (payload: Record<string, unknown>) => receive('output', payload)
  const receiveExit = (payload: Record<string, unknown>) => receive('exit', payload)
  client.socket.on('terminal:output', receiveOutput)
  client.socket.on('terminal:exit', receiveExit)

  return {
    async attach(lastAcknowledgedSequence = 0) {
      if (disposed) throw new Error('Terminal client is disposed')
      if (negotiating) throw new Error('Terminal attach is already in progress')
      negotiating = true
      negotiationError = null
      try {
        const result = await emitWithAck(
          client,
          'terminal:attach',
          terminalPayload({
            protocol_version: protocolVersion ?? 2,
            ...(protocolVersion !== 1 ? { last_acked_sequence: lastAcknowledgedSequence } : {}),
          })
        )
        if (disposed) throw new Error('Terminal client is disposed')
        if (negotiationError) throw negotiationError
        const selected = result.protocol_version === undefined ? 1 : result.protocol_version
        if (selected !== 1 && selected !== 2) throw new Error('Unsupported terminal protocol')
        if (
          (protocolVersion !== null && selected !== protocolVersion) ||
          (protocolVersion === null && selected === 1 && lastAcknowledgedSequence > 0)
        ) {
          throw new Error('Terminal protocol changed; open a new terminal session')
        }
        protocolVersion = selected
        pendingEvents.forEach(({ event, payload }) => dispatch(event, payload))
      } finally {
        negotiating = false
        pendingEvents.length = 0
        pendingCharacters = 0
      }
    },
    async ack(sequence: number) {
      if (protocolVersion === 1) return
      if (protocolVersion === null) throw new Error('Terminal session is not attached')
      await emitWithAck(client, 'terminal:ack', terminalPayload({ sequence }))
    },
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
    async close() {
      if (disposed) return
      await emitWithAck(client, 'terminal:close', terminalPayload({}))
    },
    onOutput(handler: (payload: RemoteTerminalOutputPayload) => void) {
      outputHandlers.add(handler)
      return () => {
        outputHandlers.delete(handler)
      }
    },
    onExit(handler: (payload: RemoteTerminalExitPayload) => void) {
      exitHandlers.add(handler)
      return () => {
        exitHandlers.delete(handler)
      }
    },
    onDisconnect(handler: () => void) {
      client.socket.on('disconnect', handler)
      return () => client.socket.off('disconnect', handler)
    },
    onReconnect(handler: () => void) {
      return client.onReconnect(handler)
    },
    dispose() {
      disposed = true
      pendingEvents.length = 0
      pendingCharacters = 0
      outputHandlers.clear()
      exitHandlers.clear()
      client.socket.off('terminal:output', receiveOutput)
      client.socket.off('terminal:exit', receiveExit)
      client.dispose()
    },
  }
}

async function emitWithAck(
  client: AuthenticatedSocketClient,
  event: string,
  payload: Record<string, unknown>
): Promise<TerminalAck> {
  await client.ensureConnected()
  return new Promise<TerminalAck>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`${event} timed out`))
    }, ACK_TIMEOUT_MS)

    client.socket.emit(event, payload, (ack: TerminalAck | undefined) => {
      window.clearTimeout(timeout)
      if (ack?.error || ack?.success !== true) {
        reject(new Error(ack?.error || 'Invalid terminal acknowledgement'))
        return
      }
      resolve(ack)
    })
  })
}
