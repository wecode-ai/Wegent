import { randomUUID } from 'node:crypto'
import { LocalEndpointTransport } from './local-endpoint-transport.js'

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
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.pending = new Map()
    this.description = null
    this.negotiationPromise = null
    this.started = false
    this.transport.on('message', message => this.handleMessage(message))
    this.transport.on('close', () => this.handleDisconnect())
    this.transport.on('transportError', error => this.handleTransportError(error))
    this.transport.on('reconnected', () => {
      void this.beginNegotiation().catch(error => this.handleTransportError(error))
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

  request(method, params = {}, timeoutMs = this.requestTimeoutMs, requestId) {
    if (method !== 'executor.protocol.describe') {
      if (!this.description && this.negotiationPromise) {
        return this.negotiationPromise.then(() =>
          this.request(method, params, timeoutMs, requestId)
        )
      }
      assertRendererMethod(method, this.description?.renderer_methods)
    }
    if (!this.started && method !== 'executor.protocol.describe') {
      return Promise.reject(
        new ExecutorRuntimeError('runtime_not_ready', 'Executor runtime is not ready', true)
      )
    }
    const id = requestId?.trim() || randomUUID()
    if (this.pending.has(id)) {
      return Promise.reject(
        new ExecutorRuntimeError(
          'duplicate_request_id',
          `Executor request ID ${id} is already in flight`
        )
      )
    }
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
      return
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
  }

  handleTransportError(error) {
    this.description = null
    this.failPending(
      new ExecutorRuntimeError(
        'transport_unavailable',
        error instanceof Error ? error.message : String(error),
        true
      )
    )
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
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
