import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { gunzipSync } from 'node:zlib'

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_DECOMPRESSED_RESPONSE_BYTES = 64 * 1024 * 1024
const COMPRESSED_ENCODING = 'gzip+base64+json'

export class LocalEndpointTransport extends EventEmitter {
  constructor(options) {
    super()
    this.endpoint = options.endpoint
    this.token = options.token
    this.reconnectDelayMs = options.reconnectDelayMs ?? 250
    this.socket = null
    this.running = false
    this.authenticated = false
    this.buffer = ''
    this.startPromise = null
    this.reconnectTimer = null
    this.hasConnected = false
  }

  async start() {
    if (this.authenticated) return
    this.running = true
    this.startPromise ??= this.connect()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  send(message) {
    if (!this.authenticated || !this.socket) {
      throw new Error('Local executor transport is not connected')
    }
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  async stop() {
    this.running = false
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    this.authenticated = false
    if (!socket || socket.destroyed) return
    await new Promise(resolve => {
      socket.once('close', resolve)
      socket.destroy()
    })
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint)
      this.socket = socket
      this.buffer = ''
      let settled = false
      const failStart = error => {
        if (settled) return
        settled = true
        reject(error)
      }
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({
            type: 'authenticate',
            protocol_version: 1,
            token: this.token,
            receive_events: false,
          })}\n`
        )
      })
      socket.on('data', chunk => {
        this.buffer += chunk
        if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
          socket.destroy(new Error('Executor frame exceeds size limit'))
          return
        }
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            socket.destroy(new Error('Executor returned invalid JSON'))
            return
          }
          if (!this.authenticated) {
            if (
              message.type !== 'authenticated' ||
              message.ok !== true ||
              message.protocol_version !== 1
            ) {
              const error = new Error(
                message.error?.message ?? 'Local executor authentication failed'
              )
              failStart(error)
              socket.destroy()
              return
            }
            this.authenticated = true
            const reconnected = this.hasConnected
            this.hasConnected = true
            if (!settled) {
              settled = true
              resolve()
            }
            if (reconnected) this.emit('reconnected')
            continue
          }
          this.emit('message', decodeResponse(message))
        }
      })
      socket.once('error', error => {
        failStart(error)
        this.emit('transportError', error)
      })
      socket.once('close', () => {
        const wasAuthenticated = this.authenticated
        this.authenticated = false
        if (this.socket === socket) this.socket = null
        if (wasAuthenticated) this.emit('close')
        if (this.running) this.scheduleReconnect()
      })
    })
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch(error => {
        this.emit('transportError', error)
        if (this.running) this.scheduleReconnect()
      })
    }, this.reconnectDelayMs)
    this.reconnectTimer.unref()
  }
}

function decodeResponse(message) {
  const result = message?.type === 'response' ? message.result : null
  if (
    !result ||
    typeof result !== 'object' ||
    result.__runtimeRpcEncoding !== COMPRESSED_ENCODING ||
    typeof result.payload !== 'string'
  ) {
    return message
  }
  return {
    ...message,
    result: JSON.parse(
      gunzipSync(Buffer.from(result.payload, 'base64'), {
        maxOutputLength: MAX_DECOMPRESSED_RESPONSE_BYTES,
      }).toString('utf8')
    ),
  }
}
