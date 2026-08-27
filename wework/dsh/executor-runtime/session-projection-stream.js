import { LocalEndpointEventStream } from './local-endpoint-event-stream.js'

const RECONNECT_DELAY_MS = 250

export class ExecutorSessionProjectionStream {
  constructor(projector, options = {}) {
    this.projector = projector
    this.createEventStream =
      options.createEventStream ??
      (streamOptions => LocalEndpointEventStream.fromEnvironment(streamOptions))
    this.onError = options.onError ?? (() => {})
    this.afterSequence = 0
    this.active = false
    this.stream = null
    this.reconnectTimer = null
  }

  start() {
    if (this.active) return
    this.active = true
    this.connect()
  }

  stop() {
    this.active = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stream?.stop()
    this.stream = null
  }

  connect() {
    if (!this.active) return
    const stream = this.createEventStream({
      afterSequence: this.afterSequence,
      onEvent: event => {
        if (Number.isSafeInteger(event.sequence) && event.sequence > this.afterSequence) {
          this.afterSequence = event.sequence
        }
        try {
          this.projector.handle(event)
        } catch (error) {
          this.onError(error)
        }
      },
      onClose: () => this.reconnect(),
    })
    this.stream = stream
    Promise.resolve(stream.start()).catch(error => {
      this.onError(error)
      this.reconnect()
    })
  }

  reconnect() {
    if (!this.active || this.reconnectTimer) return
    this.stream?.stop()
    this.stream = null
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, RECONNECT_DELAY_MS)
  }
}
