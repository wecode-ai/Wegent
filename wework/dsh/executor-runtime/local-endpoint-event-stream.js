import { createConnection } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { ExecutorRuntimeError } from './executor-runtime-client.js'

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_AUTH_FRAME_BYTES = 64 * 1024
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 10_000

export class LocalEndpointEventByteStream {
  constructor(options) {
    this.endpoint = options.endpoint
    this.token = options.token
    this.afterSequence = options.afterSequence
    this.replayExisting = options.replayExisting ?? true
    this.socket = null
    this.authenticated = false
    this.stopped = false
    this.authenticationTimeoutMs =
      options.authenticationTimeoutMs ?? DEFAULT_AUTHENTICATION_TIMEOUT_MS
    this.authenticationTimer = null
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
    return new this({ ...options, endpoint, token })
  }

  start() {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint)
      this.socket = socket
      let buffer = Buffer.alloc(0)
      let settled = false
      const clearAuthenticationTimer = () => {
        if (this.authenticationTimer === null) return
        clearTimeout(this.authenticationTimer)
        this.authenticationTimer = null
      }
      const rejectStart = error => {
        if (settled) return
        settled = true
        clearAuthenticationTimer()
        reject(error)
      }
      const cleanupAuthenticationListeners = () => {
        socket.off('data', authenticate)
        socket.off('error', rejectStart)
        socket.off('close', rejectClosedStart)
      }
      const rejectClosedStart = () => {
        rejectStart(new Error('Executor event stream closed before authentication'))
      }
      const authenticate = chunk => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf(0x0a)
        if (newline < 0) {
          if (buffer.byteLength > MAX_AUTH_FRAME_BYTES) {
            socket.destroy(new Error('Executor authentication response exceeds size limit'))
          }
          return
        }
        if (newline > MAX_AUTH_FRAME_BYTES) {
          socket.destroy(new Error('Executor authentication response exceeds size limit'))
          return
        }
        const line = buffer.subarray(0, newline).toString('utf8')
        const remainder = buffer.subarray(newline + 1)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          socket.destroy(new Error('Executor returned an invalid authentication response'))
          return
        }
        if (
          message.type !== 'authenticated' ||
          message.ok !== true ||
          message.protocol_version !== 1
        ) {
          rejectStart(
            new ExecutorRuntimeError(
              message.error?.code ?? 'authentication_failed',
              message.error?.message ?? 'Local executor authentication failed'
            )
          )
          socket.destroy()
          return
        }
        this.authenticated = true
        settled = true
        clearAuthenticationTimer()
        cleanupAuthenticationListeners()
        socket.pause()
        if (remainder.length > 0) socket.unshift(remainder)
        resolve(socket)
      }
      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({
            type: 'authenticate',
            protocol_version: 1,
            token: this.token,
            event_stream: true,
            after_sequence: this.afterSequence,
            replay_existing: this.replayExisting,
          })}\n`
        )
      })
      socket.on('data', authenticate)
      socket.once('error', rejectStart)
      socket.once('close', rejectClosedStart)
      this.authenticationTimer = setTimeout(() => {
        const error = new ExecutorRuntimeError(
          'authentication_timeout',
          'Executor event stream authentication timed out',
          true
        )
        rejectStart(error)
        socket.destroy(error)
      }, this.authenticationTimeoutMs)
      this.authenticationTimer.unref?.()
      socket.once('close', () => {
        clearAuthenticationTimer()
        this.authenticated = false
        if (this.socket === socket) this.socket = null
      })
    })
  }

  stop() {
    this.stopped = true
    if (this.authenticationTimer !== null) {
      clearTimeout(this.authenticationTimer)
      this.authenticationTimer = null
    }
    const socket = this.socket
    this.socket = null
    this.authenticated = false
    if (socket && !socket.destroyed) socket.destroy()
  }
}

export class LocalEndpointEventStream {
  constructor(options) {
    this.onEvent = options.onEvent
    this.onClose = options.onClose
    this.byteStream = new LocalEndpointEventByteStream(options)
    this.source = null
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.stopped = false
  }

  static fromEnvironment(options, environment = process.env) {
    const byteStream = LocalEndpointEventByteStream.fromEnvironment(options, environment)
    const stream = new LocalEndpointEventStream(options)
    stream.byteStream = byteStream
    return stream
  }

  async start() {
    const source = await this.byteStream.start()
    this.source = source
    let closed = false
    const close = error => {
      if (closed || this.stopped) return
      closed = true
      this.onClose(error)
    }
    source.on('data', chunk => this.handleChunk(chunk))
    source.once('error', close)
    source.once('close', () => close())
    source.resume()
  }

  handleChunk(chunk) {
    this.buffer += this.decoder.write(chunk)
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.source?.destroy(new Error('Executor event frame exceeds size limit'))
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
        this.source?.destroy(new Error('Executor returned an invalid event'))
        return
      }
      if (message.type === 'event') this.onEvent(message)
    }
  }

  stop() {
    this.stopped = true
    this.source = null
    this.byteStream.stop()
  }
}
