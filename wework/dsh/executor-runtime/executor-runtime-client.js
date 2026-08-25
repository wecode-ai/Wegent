import { randomUUID } from 'node:crypto'
import { LocalEndpointTransport } from './local-endpoint-transport.js'

const DEFAULT_BUFFER_SIZE = 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
export class ExecutorRuntimeError extends Error {
  constructor(code, message, retryable = false, details = {}) {
    super(message)
    this.name = 'ExecutorRuntimeError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export class ExecutorRuntimeClient {
  constructor(options) {
    this.transport = options.transport
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.listeners = new Set()
    this.events = []
    this.pending = new Map()
    this.nextSequence = 1
    this.description = null
    this.negotiationPromise = null
    this.started = false
    this.transport.on('message', message => this.handleMessage(message))
    this.transport.on('close', () => this.handleDisconnect())
    this.transport.on('transportError', error => this.publishTransportError(error))
    this.transport.on('reconnected', () => {
      void this.beginNegotiation().catch(error => this.publishTransportError(error))
    })
  }

  static fromEnvironment(environment = process.env) {
    const endpoint = environment.WEWORK_EXECUTOR_ENDPOINT?.trim()
    const token = environment.WEWORK_EXECUTOR_TOKEN?.trim()
    if (!endpoint || !token) {
      throw new ExecutorRuntimeError(
        'runtime_not_configured',
        'Executor runtime endpoint is not configured'
      )
    }
    return new ExecutorRuntimeClient({
      transport: new LocalEndpointTransport({ endpoint, token }),
    })
  }

  async start() {
    if (this.started) return
    try {
      await this.transport.start()
      await this.beginNegotiation()
      this.started = true
    } catch (error) {
      await this.transport.stop()
      throw error
    }
  }

  async stop() {
    this.started = false
    this.description = null
    this.negotiationPromise = null
    this.failPending(new ExecutorRuntimeError('runtime_stopped', 'Executor runtime stopped', true))
    await this.transport.stop()
  }

  describe() {
    if (!this.description) {
      throw new ExecutorRuntimeError('runtime_not_ready', 'Executor runtime is not ready', true)
    }
    return this.description
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (method !== 'executor.protocol.describe') {
      if (!this.description && this.negotiationPromise) {
        return this.negotiationPromise.then(() => this.request(method, params, timeoutMs))
      }
      assertRendererMethod(method, this.description?.renderer_methods)
    }
    if (!this.started && method !== 'executor.protocol.describe') {
      return Promise.reject(
        new ExecutorRuntimeError('runtime_not_ready', 'Executor runtime is not ready', true)
      )
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new ExecutorRuntimeError('request_timeout', `Executor request ${method} timed out`, true)
        )
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.transport.send({ type: 'request', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(
          new ExecutorRuntimeError(
            'transport_unavailable',
            error instanceof Error ? error.message : String(error),
            true
          )
        )
      }
    })
  }

  subscribe(listener, afterSequence = 0) {
    for (const event of this.replay(afterSequence)) listener(event)
    return this.listen(listener)
  }

  listen(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replay(afterSequence) {
    const oldest = this.events[0]?.sequence ?? this.nextSequence
    if (afterSequence > 0 && afterSequence < oldest - 1) {
      throw new ExecutorRuntimeError(
        'event_history_lost',
        'Requested executor event history is no longer buffered',
        true,
        { requestedAfter: afterSequence, oldestAvailable: oldest }
      )
    }
    return this.events.filter(event => event.sequence > afterSequence)
  }

  async negotiate() {
    const description = await this.request('executor.protocol.describe', {})
    if (
      description?.protocol_version !== 1 ||
      typeof description.device_id !== 'string' ||
      !Array.isArray(description.capabilities) ||
      !validRendererMethods(description.renderer_methods)
    ) {
      throw new ExecutorRuntimeError(
        'protocol_mismatch',
        'Executor returned an invalid protocol description'
      )
    }
    this.description = description
  }

  beginNegotiation() {
    if (this.negotiationPromise) return this.negotiationPromise
    const negotiation = this.negotiate().finally(() => {
      if (this.negotiationPromise === negotiation) {
        this.negotiationPromise = null
      }
    })
    this.negotiationPromise = negotiation
    return negotiation
  }

  handleMessage(message) {
    if (message?.type === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.ok) {
        pending.resolve(message.result)
      } else {
        pending.reject(
          new ExecutorRuntimeError(
            message.error?.code ?? 'executor_request_failed',
            message.error?.message ?? 'Executor request failed',
            message.error?.retryable ?? false,
            message.error?.details ?? {}
          )
        )
      }
      return
    }
    if (message?.type === 'event' && typeof message.event === 'string') {
      this.publish(message)
    }
  }

  handleDisconnect() {
    this.description = null
    this.negotiationPromise = null
    this.failPending(
      new ExecutorRuntimeError(
        'transport_disconnected',
        'Executor runtime transport disconnected',
        true
      )
    )
    this.publish({
      event: 'executor.transport_disconnected',
      payload: {},
    })
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  publishTransportError(error) {
    this.publish({
      event: 'executor.transport_error',
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }

  publish(value) {
    const upstreamSequence = value.sequence ?? value.payload?.eventSeq ?? value.payload?.event_seq
    const event = {
      protocolVersion: 1,
      sequence:
        Number.isSafeInteger(upstreamSequence) && upstreamSequence > 0
          ? upstreamSequence
          : this.nextSequence,
      emittedAt: new Date().toISOString(),
      event: value.event,
      payload: value.payload ?? {},
    }
    this.nextSequence = Math.max(this.nextSequence, event.sequence + 1)
    this.events.push(event)
    if (this.events.length > this.bufferSize) this.events.shift()
    for (const listener of this.listeners) listener(event)
  }
}

function validRendererMethods(methods) {
  return (
    Array.isArray(methods) &&
    methods.length > 0 &&
    methods.every(
      method =>
        typeof method === 'string' &&
        method.length > 0 &&
        (!method.includes('*') || method.endsWith('.*'))
    )
  )
}

function assertRendererMethod(method, allowedMethods) {
  const allowed =
    typeof method === 'string' &&
    validRendererMethods(allowedMethods) &&
    allowedMethods.some(pattern =>
      pattern.endsWith('.*') ? method.startsWith(pattern.slice(0, -1)) : method === pattern
    )
  if (!allowed) {
    throw new ExecutorRuntimeError(
      'method_not_allowed',
      `Executor method is not declared for Renderer access: ${String(method)}`
    )
  }
}
