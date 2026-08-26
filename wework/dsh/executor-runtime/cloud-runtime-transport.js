import { EventEmitter } from 'node:events'
import { gunzipSync } from 'node:zlib'

const REQUEST_EVENT = 'runtime:request'
const RUNTIME_EVENT = 'runtime:event'
const COMPRESSED_ENCODING = 'gzip+base64+json'

export class CloudRuntimeTransport extends EventEmitter {
  constructor(options) {
    super()
    this.socket = options.socket
    this.deviceId = options.deviceId
    this.timeoutMs = options.timeoutMs ?? 75_000
    this.disposeSocket = options.disposeSocket !== false
    this.started = false
    this.onRuntimeEvent = value => {
      if (isExecutorMessage(value)) this.emit('message', value)
    }
  }

  async start() {
    if (this.started) return
    if (!this.deviceId?.trim()) throw new Error('Cloud executor deviceId is required')
    await this.socket.ensureConnected()
    this.socket.on(RUNTIME_EVENT, this.onRuntimeEvent)
    this.started = true
  }

  send(request) {
    if (!this.started) throw new Error('Cloud executor transport is not connected')
    this.socket.emit(
      REQUEST_EVENT,
      {
        ...request,
        device_id: this.deviceId,
        timeout_seconds: Math.ceil(this.timeoutMs / 1000),
      },
      acknowledgement => {
        try {
          this.emit('message', relayResponse(request.id, acknowledgement))
        } catch (error) {
          this.emit('transportError', error)
        }
      }
    )
  }

  async stop() {
    if (!this.started) return
    this.started = false
    this.socket.off(RUNTIME_EVENT, this.onRuntimeEvent)
    if (this.disposeSocket) this.socket.dispose()
    this.emit('close')
  }
}

function relayResponse(requestId, acknowledgement) {
  if (!isRecord(acknowledgement)) {
    throw new Error('Cloud executor returned an invalid acknowledgement')
  }
  const response = {
    ...acknowledgement,
    type: 'response',
    id:
      typeof acknowledgement.id === 'string' && acknowledgement.id.trim()
        ? acknowledgement.id
        : requestId,
    ...(acknowledgement.result !== undefined
      ? { result: decodeRelayResult(acknowledgement.result) }
      : {}),
  }
  if (!isExecutorMessage(response) || response.type !== 'response') {
    throw new Error('Cloud executor returned an invalid response envelope')
  }
  return response
}

function decodeRelayResult(result) {
  if (
    !isRecord(result) ||
    result.__runtimeRpcEncoding !== COMPRESSED_ENCODING ||
    typeof result.payload !== 'string'
  ) {
    return result
  }
  return JSON.parse(gunzipSync(Buffer.from(result.payload, 'base64')).toString('utf8'))
}

function isExecutorMessage(value) {
  if (!isRecord(value)) return false
  if (value.type === 'response') {
    return (
      typeof value.id === 'string' &&
      typeof value.ok === 'boolean' &&
      (value.ok || isRecord(value.error))
    )
  }
  return value.type === 'event' && typeof value.event === 'string' && isRecord(value.payload)
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
