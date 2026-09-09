import { createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

export const ELECTRON_HOST_PROTOCOL_VERSION = 1
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_PRINCIPAL = '@wegent/dsh-app-wework'

export class ElectronHostError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ElectronHostError'
    this.code = code
    this.details = details
  }
}

export class ElectronHostClient {
  static fromEnvironment(environment = process.env, options = {}) {
    const protocolVersion = requiredInteger(
      environment.WEWORK_ELECTRON_HOST_PROTOCOL,
      'WEWORK_ELECTRON_HOST_PROTOCOL'
    )
    if (protocolVersion !== ELECTRON_HOST_PROTOCOL_VERSION) {
      throw new ElectronHostError(
        'protocol_mismatch',
        `Unsupported Electron host protocol ${protocolVersion}`
      )
    }
    const token = requiredString(
      environment.WEWORK_ELECTRON_HOST_TOKEN,
      'WEWORK_ELECTRON_HOST_TOKEN'
    )
    const requestFd = requiredInteger(
      environment.WEWORK_ELECTRON_HOST_REQUEST_FD,
      'WEWORK_ELECTRON_HOST_REQUEST_FD'
    )
    const responseFd = requiredInteger(
      environment.WEWORK_ELECTRON_HOST_RESPONSE_FD,
      'WEWORK_ELECTRON_HOST_RESPONSE_FD'
    )
    const principal =
      optionalString(environment.WEWORK_ELECTRON_HOST_PRINCIPAL) ?? DEFAULT_PRINCIPAL
    return new ElectronHostClient({
      protocolVersion,
      token,
      input: createReadStream(null, { fd: requestFd, autoClose: false }),
      output: createWriteStream(null, { fd: responseFd, autoClose: false }),
      principal,
      onDisconnect: options.onDisconnect,
    })
  }

  constructor({
    protocolVersion = ELECTRON_HOST_PROTOCOL_VERSION,
    token,
    input,
    output,
    principal = DEFAULT_PRINCIPAL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onDisconnect = () => {},
  }) {
    this.protocolVersion = protocolVersion
    this.token = token
    this.input = input
    this.output = output
    this.principal = principal
    this.timeoutMs = timeoutMs
    this.onDisconnect = onDisconnect
    this.lines = null
    this.capabilities = new Set()
    this.pending = new Map()
    this.sequence = 0
    this.started = false
    this.closed = false
    this.handshake = null
    this.onInputClose = () => {
      this.closeWithError(new ElectronHostError('host_disconnected', 'Electron host pipe closed'))
    }
    this.onInputEnd = () => {
      this.closeWithError(new ElectronHostError('host_disconnected', 'Electron host pipe ended'))
    }
    this.onOutputError = error => this.closeWithError(normalizeError(error))
  }

  async start() {
    if (this.started) return this.describe()
    if (this.closed) {
      throw new ElectronHostError('client_closed', 'Electron host client is closed')
    }
    this.started = true
    this.lines = createInterface({ input: this.input })
    this.lines.on('line', line => this.handleLine(line))
    this.input.once('close', this.onInputClose)
    this.input.once('end', this.onInputEnd)
    this.output.once('error', this.onOutputError)
    this.handshake = deferred()
    this.write({
      type: 'hello',
      protocolVersion: this.protocolVersion,
      token: this.token,
      principal: this.principal,
    })
    await withTimeout(this.handshake.promise, this.timeoutMs, 'Electron host handshake timed out')
    return this.describe()
  }

  describe() {
    return {
      protocolVersion: this.protocolVersion,
      capabilities: [...this.capabilities],
    }
  }

  async invoke(capability, params = {}) {
    if (!this.started || !this.handshake) {
      throw new ElectronHostError('client_not_ready', 'Electron host client has not started')
    }
    await this.handshake.promise
    if (!this.capabilities.has(capability)) {
      throw new ElectronHostError(
        'capability_denied',
        `Electron host capability is unavailable: ${capability}`,
        { capability }
      )
    }
    if (!isRecord(params)) {
      throw new ElectronHostError('invalid_params', 'params must be an object')
    }
    const id = `dsh-${++this.sequence}`
    const response = deferred()
    this.pending.set(id, response)
    this.write({ type: 'request', id, capability, params })
    try {
      return await withTimeout(
        response.promise,
        this.timeoutMs,
        `Electron host request timed out: ${capability}`
      )
    } finally {
      this.pending.delete(id)
    }
  }

  stop() {
    if (this.closed) return
    this.closed = true
    this.started = false
    this.lines?.close()
    this.lines = null
    this.input.off('close', this.onInputClose)
    this.input.off('end', this.onInputEnd)
    this.output.off('error', this.onOutputError)
    if (!this.output.destroyed) this.output.end()
    this.rejectPending(new ElectronHostError('client_closed', 'Electron host client stopped'))
  }

  handleLine(rawLine) {
    if (Buffer.byteLength(rawLine) > MAX_FRAME_BYTES) {
      this.closeWithError(
        new ElectronHostError('frame_too_large', 'Electron host response exceeds size limit')
      )
      return
    }
    let message
    try {
      message = JSON.parse(rawLine)
    } catch {
      this.closeWithError(
        new ElectronHostError('invalid_frame', 'Electron host returned invalid JSON')
      )
      return
    }
    if (!isRecord(message)) {
      this.closeWithError(
        new ElectronHostError('invalid_frame', 'Electron host frame must be an object')
      )
      return
    }
    if (this.handshake && !this.handshake.settled) {
      this.handleHello(message)
      return
    }
    this.handleResponse(message)
  }

  handleHello(message) {
    if (
      message.type !== 'hello' ||
      message.ok !== true ||
      message.protocolVersion !== this.protocolVersion ||
      !Array.isArray(message.capabilities) ||
      message.capabilities.some(capability => typeof capability !== 'string')
    ) {
      this.closeWithError(
        new ElectronHostError('handshake_rejected', 'Electron host returned an invalid handshake')
      )
      return
    }
    this.capabilities = new Set(message.capabilities)
    this.handshake.resolve()
  }

  handleResponse(message) {
    if (message.type !== 'response' || typeof message.id !== 'string') {
      this.closeWithError(
        new ElectronHostError('invalid_response', 'Electron host returned a malformed response')
      )
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.ok === true) {
      pending.resolve(message.result)
      return
    }
    const error = isRecord(message.error) ? message.error : {}
    pending.reject(
      new ElectronHostError(
        typeof error.code === 'string' ? error.code : 'capability_failed',
        typeof error.message === 'string' ? error.message : 'Electron host capability failed',
        isRecord(error.details) ? error.details : {}
      )
    )
  }

  write(message) {
    if (this.closed || this.output.destroyed) {
      throw new ElectronHostError('host_disconnected', 'Electron host pipe is closed')
    }
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  closeWithError(error) {
    if (this.closed) return
    this.closed = true
    this.started = false
    this.handshake?.reject(error)
    this.rejectPending(error)
    this.lines?.close()
    this.lines = null
    this.onDisconnect(error)
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ElectronHostError('invalid_environment', `${name} is required`)
  }
  return value.trim()
}

function requiredInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ElectronHostError('invalid_environment', `${name} must be an integer`)
  }
  return parsed
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function deferred() {
  const result = {
    settled: false,
    promise: null,
    resolve: null,
    reject: null,
  }
  result.promise = new Promise((resolve, reject) => {
    result.resolve = value => {
      if (result.settled) return
      result.settled = true
      resolve(value)
    }
    result.reject = error => {
      if (result.settled) return
      result.settled = true
      reject(error)
    }
  })
  return result
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ElectronHostError('host_timeout', message)),
      timeoutMs
    )
    timer.unref()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function normalizeError(error) {
  return error instanceof ElectronHostError
    ? error
    : new ElectronHostError(
        'host_disconnected',
        error instanceof Error ? error.message : String(error)
      )
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
