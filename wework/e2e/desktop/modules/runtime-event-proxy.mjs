import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'

import { TransportFaultProxy } from './transport-fault-proxy.mjs'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Schedule real Runtime events without replacing its socket, auth, RPC or API. */
export class RuntimeEventProxy extends TransportFaultProxy {
  constructor(target) {
    super(target)
    this.events = []
    this.hold = () => false
    this.waiters = new Set()
    this.delivery = new WeakMap()
    this.failure = null
    this.nextAckId = 1_000_000_000
    this.acknowledgements = new Map()
    this.ownedAckIds = new Set()
  }

  upgrade(request, downstream, head) {
    const options = this.options(request)
    // Inspect uncompressed messages while preserving the actual endpoint handshake.
    delete options.headers['sec-websocket-extensions']
    const upstream = httpRequest(options)
    this.upstreams.add(upstream)
    upstream.once('close', () => this.upstreams.delete(upstream))
    upstream.on('error', error => {
      this.fail(error)
      downstream.destroy()
    })
    downstream.once('close', () => upstream.destroy())
    upstream.once('response', response => {
      response.resume()
      this.fail(new Error(`Runtime WebSocket upgrade returned HTTP ${response.statusCode}`))
      downstream.destroy()
    })
    upstream.once('upgrade', (response, socket, upstreamHead) => {
      this.bridgeWebsocket({ response, socket, downstream, head, upstreamHead })
    })
    upstream.end()
  }

  bridgeWebsocket({ response, socket, downstream, head, upstreamHead }) {
    this.track(socket)
    this.websockets.add(socket)
    socket.once('close', () => {
      this.websockets.delete(socket)
      for (const [id, pending] of this.acknowledgements) {
        if (pending.socket === socket) {
          this.finishAcknowledgement(id, new Error('The original Runtime socket closed before ACK'))
        }
      }
      downstream.destroy()
    })
    downstream.once('close', () => socket.destroy())
    const headers = response.rawHeaders.reduce((lines, value, index, all) => {
      if (index % 2 === 0) lines.push(`${value}: ${all[index + 1]}`)
      return lines
    }, [])
    downstream.write(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers.join('\r\n')}\r\n\r\n`
    )
    this.readMessages(downstream, head, message => this.forwardMessage(socket, message))
    this.readMessages(socket, upstreamHead, message => {
      if (!this.consumeAcknowledgement(message.text)) {
        for (const frame of message.frames) downstream.write(frame)
      }
    })
  }

  readMessages(socket, head, handle) {
    const messages = new WebSocketMessages()
    const receive = chunk => {
      try {
        for (const message of messages.push(chunk)) handle(message)
      } catch (error) {
        this.fail(error)
        socket.destroy()
      }
    }
    socket.on('data', receive)
    if (head.length) receive(head)
  }

  forwardMessage(socket, { frames, text }) {
    const envelope = runtimeEnvelope(text)
    if (!envelope) {
      for (const frame of frames) socket.write(frame)
      return
    }
    const entry = {
      envelope,
      event: envelope.event,
      payload: envelope.payload,
      held: Boolean(this.hold(envelope)),
      deliveries: 0,
    }
    this.delivery.set(entry, { socket })
    this.events.push(entry)
    if (!entry.held) {
      for (const frame of frames) socket.write(frame)
      entry.deliveries += 1
    }
    for (const waiter of [...this.waiters]) {
      if (this.events.length > waiter.after && waiter.predicate(entry)) {
        this.finishWaiter(waiter, null, entry)
      }
    }
  }

  waitForEvent(predicate, { after = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.failure) return Promise.reject(this.failure)
    const found = this.events.slice(after).find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, after, resolve, reject }
      waiter.timer = setTimeout(
        () =>
          this.finishWaiter(waiter, new Error(`No matching Runtime event within ${timeoutMs}ms`)),
        timeoutMs
      )
      this.waiters.add(waiter)
    })
  }

  async release(entry) {
    assert.equal(entry.held, true, 'Only a held Runtime event can be released')
    await this.deliverAcknowledged(entry, entry.envelope)
    entry.held = false
    entry.deliveries += 1
  }

  async replay(entry, payloadOverrides) {
    // Negative cases may omit sequencing/body facts, retaining captured identities.
    const envelope = {
      ...entry.envelope,
      payload: { ...entry.payload, ...payloadOverrides },
    }
    await this.deliverAcknowledged(entry, envelope)
    entry.deliveries += 1
  }

  deliverAcknowledged(entry, envelope) {
    const { socket } = this.deliveryFor(entry)
    const id = this.nextAckId++
    this.ownedAckIds.add(id)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.finishAcknowledgement(id, new Error('Backend Runtime event ACK timed out')),
        DEFAULT_TIMEOUT_MS
      )
      this.acknowledgements.set(id, { socket, resolve, reject, timer })
      const frame = maskedTextFrame(
        `42/local-executor,${id}${JSON.stringify(['runtime:event', envelope])}`
      )
      socket.write(frame, error => {
        if (error) this.finishAcknowledgement(id, error)
      })
    })
  }

  consumeAcknowledgement(text) {
    const match = typeof text === 'string' && /^43\/local-executor,(\d+)(\[.*)$/s.exec(text)
    if (!match || !this.ownedAckIds.has(Number(match[1]))) return false
    const response = JSON.parse(match[2])
    this.finishAcknowledgement(
      Number(match[1]),
      response[0]?.success === true ? null : new Error('Backend rejected scheduled Runtime event')
    )
    return true
  }

  finishAcknowledgement(id, error) {
    const pending = this.acknowledgements.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.acknowledgements.delete(id)
    if (error) pending.reject(error)
    else pending.resolve()
  }

  deliveryFor(entry) {
    const delivery = this.delivery.get(entry)
    assert.ok(delivery, 'Runtime event was not captured by this proxy')
    assert.equal(delivery.socket.destroyed, false, 'The original Runtime socket has closed')
    return delivery
  }

  finishWaiter(waiter, error, entry) {
    clearTimeout(waiter.timer)
    this.waiters.delete(waiter)
    if (error) waiter.reject(error)
    else waiter.resolve(entry)
  }

  fail(error) {
    this.failure ??= error
    for (const waiter of [...this.waiters]) this.finishWaiter(waiter, this.failure)
    for (const id of this.acknowledgements.keys()) this.finishAcknowledgement(id, this.failure)
  }

  async stop() {
    this.fail(new Error('Runtime event proxy stopped'))
    await super.stop()
  }
}

function runtimeEnvelope(text) {
  if (typeof text !== 'string' || !/^42\/local-executor,\d*\[/.test(text)) return null
  const packet = JSON.parse(text.slice(text.indexOf('[')))
  if (packet[0] !== 'runtime:event') return null
  const envelope = packet[1]
  assert.equal(typeof envelope?.event, 'string', 'Malformed Runtime event envelope')
  assert.equal(typeof envelope?.payload, 'object', 'Malformed Runtime event payload')
  return envelope
}

/** Buffer TCP chunks and fragmented WebSocket messages; control frames stay live. */
class WebSocketMessages {
  buffer = Buffer.alloc(0)
  fragments = []
  opcode = null

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages = []
    while (this.buffer.length >= 2) {
      const frame = this.readFrame()
      if (!frame) break
      if (frame.opcode >= 8) {
        messages.push({ frames: [frame.raw], text: null })
        continue
      }
      if (frame.opcode !== 0) {
        assert.equal(this.opcode, null, 'Overlapping WebSocket messages')
        this.opcode = frame.opcode
      } else {
        assert.notEqual(this.opcode, null, 'Unexpected WebSocket continuation')
      }
      this.fragments.push(frame)
      if (frame.final) {
        messages.push({
          frames: this.fragments.map(fragment => fragment.raw),
          text:
            this.opcode === 1
              ? Buffer.concat(this.fragments.map(fragment => fragment.payload)).toString('utf8')
              : null,
        })
        this.fragments = []
        this.opcode = null
      }
    }
    return messages
  }

  readFrame() {
    const bytes = this.buffer
    assert.equal(bytes[0] & 0x70, 0, 'Compressed WebSocket messages are not enabled')
    const masked = Boolean(bytes[1] & 0x80)
    let length = bytes[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (bytes.length < 4) return null
      length = bytes.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (bytes.length < 10) return null
      const wideLength = bytes.readBigUInt64BE(2)
      assert.ok(wideLength <= BigInt(MAX_FRAME_BYTES), 'Runtime WebSocket frame is too large')
      length = Number(wideLength)
      offset = 10
    }
    assert.ok(length <= MAX_FRAME_BYTES, 'Runtime WebSocket frame is too large')
    const maskOffset = offset
    if (masked) offset += 4
    if (bytes.length < offset + length) return null
    const raw = bytes.subarray(0, offset + length)
    const payload = Buffer.from(raw.subarray(offset))
    if (masked) {
      for (let index = 0; index < length; index += 1) {
        payload[index] ^= raw[maskOffset + (index % 4)]
      }
    }
    this.buffer = bytes.subarray(raw.length)
    return { raw, payload, opcode: bytes[0] & 0x0f, final: Boolean(bytes[0] & 0x80) }
  }
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text)
  const offset = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10
  const frame = Buffer.alloc(offset + 4 + payload.length)
  frame[0] = 0x81
  frame[1] = 0x80 | (offset === 2 ? payload.length : offset === 4 ? 126 : 127)
  if (offset === 4) frame.writeUInt16BE(payload.length, 2)
  if (offset === 10) frame.writeBigUInt64BE(BigInt(payload.length), 2)
  const mask = randomBytes(4)
  mask.copy(frame, offset)
  for (let index = 0; index < payload.length; index += 1) {
    frame[offset + 4 + index] = payload[index] ^ mask[index % 4]
  }
  return frame
}
