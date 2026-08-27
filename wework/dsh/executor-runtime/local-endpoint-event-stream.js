import { createConnection } from 'node:net'
import { ExecutorRuntimeError } from './executor-runtime-client.js'

const MAX_FRAME_BYTES = 16 * 1024 * 1024

export class LocalEndpointEventStream {
  constructor(options) {
    this.endpoint = options.endpoint
    this.token = options.token
    this.afterSequence = options.afterSequence
    this.onEvent = options.onEvent
    this.onClose = options.onClose
    this.socket = null
    this.buffer = ''
    this.authenticated = false
    this.stopped = false
  }

  static fromEnvironment(options, environment = process.env) {
    const endpoint = environment.WEWORK_EXECUTOR_ENDPOINT?.trim()
    const token = environment.WEWORK_EXECUTOR_TOKEN?.trim()
    if (!endpoint || !token) {
      throw new ExecutorRuntimeError(
        'runtime_not_configured',
        'Executor runtime endpoint is not configured'
      )
    }
    return new LocalEndpointEventStream({ ...options, endpoint, token })
  }

  start() {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint)
      this.socket = socket
      let settled = false
      const rejectStart = error => {
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
            event_stream: true,
            after_sequence: this.afterSequence,
          })}\n`
        )
      })
      socket.on('data', chunk => {
        this.buffer += chunk
        if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
          socket.destroy(new Error('Executor event frame exceeds size limit'))
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
            socket.destroy(new Error('Executor returned an invalid event'))
            return
          }
          if (!this.authenticated) {
            if (
              message.type !== 'authenticated' ||
              message.ok !== true ||
              message.protocol_version !== 1
            ) {
              const error = new ExecutorRuntimeError(
                message.error?.code ?? 'authentication_failed',
                message.error?.message ?? 'Local executor authentication failed'
              )
              rejectStart(error)
              socket.destroy()
              return
            }
            this.authenticated = true
            settled = true
            resolve()
            continue
          }
          if (message.type === 'event') this.onEvent(message)
        }
      })
      socket.once('error', error => {
        rejectStart(error)
      })
      socket.once('close', () => {
        const connected = this.authenticated
        this.authenticated = false
        if (this.socket === socket) this.socket = null
        if (!settled) {
          rejectStart(new Error('Executor event stream closed before authentication'))
        } else if (connected && !this.stopped) {
          this.onClose()
        }
      })
    })
  }

  stop() {
    this.stopped = true
    const socket = this.socket
    this.socket = null
    this.authenticated = false
    if (socket && !socket.destroyed) socket.destroy()
  }
}
