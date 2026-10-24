import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { Transform } from 'node:stream'

// Preserve original frames, including masks, while observing complete text messages.
class WebSocketMessageFilter extends Transform {
  constructor(filter) {
    super()
    this.filter = filter
    this.buffer = Buffer.alloc(0)
    this.fragment = null
  }

  _transform(chunk, _encoding, done) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.readFrame()) {}
      done()
    } catch (error) {
      done(error)
    }
  }

  readFrame() {
    if (this.buffer.length < 2) return false
    const masked = Boolean(this.buffer[1] & 128)
    let length = this.buffer[1] & 127
    let offset = 2
    if (length === 126) {
      if (this.buffer.length < 4) return false
      length = this.buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (this.buffer.length < 10) return false
      const size = this.buffer.readBigUInt64BE(2)
      assert.ok(size <= 8n * 1024n * 1024n, 'Capability gate frame exceeds its bounded buffer')
      length = Number(size)
      offset = 10
    }
    const start = offset + (masked ? 4 : 0)
    if (this.buffer.length < start + length) return false
    const frame = this.buffer.subarray(0, start + length)
    this.buffer = this.buffer.subarray(frame.length)
    const payload = Buffer.from(frame.subarray(start))
    if (masked)
      for (let index = 0; index < payload.length; index += 1)
        payload[index] ^= frame[offset + (index % 4)]
    this.acceptFrame(frame, payload)
    return true
  }

  acceptFrame(frame, payload) {
    const opcode = frame[0] & 15
    if (opcode >= 8) {
      this.push(frame)
      return
    }
    assert.equal(frame[0] & 112, 0, 'Capability gate requires uncompressed WebSocket messages')
    if (opcode !== 0) {
      assert.equal(this.fragment, null, 'Interleaved WebSocket data messages')
      this.fragment = { opcode, frames: [], payloads: [] }
    }
    assert.ok(this.fragment, 'Unexpected WebSocket continuation')
    this.fragment.frames.push(frame)
    this.fragment.payloads.push(payload)
    if (!(frame[0] & 128)) return
    const message = this.fragment
    this.fragment = null
    const held =
      message.opcode === 1 &&
      this.filter(Buffer.concat(message.payloads).toString('utf8'), message.frames, this)
    if (!held) for (const original of message.frames) this.push(original)
  }
}

function capabilitySyncRequest(text) {
  const packet = text.match(/^42(\/[^,]+,)?(\d+)(\[.*)$/s)
  if (!packet) return null
  const [event, payload] = JSON.parse(packet[3])
  return event === 'device:sync_capabilities'
    ? { namespace: packet[1] ?? '', id: packet[2], payload }
    : null
}

function capabilityAcknowledgement(text, request) {
  const prefix = `43${request.namespace}${request.id}[`
  if (!text.startsWith(prefix)) return null
  const [response] = JSON.parse(text.slice(prefix.length - 1))
  const items = name =>
    (response[name] ?? []).map(item => ({ name: item.name, status: item.status }))
  return {
    success: response.success,
    scope: response.scope,
    pluginSync: response.plugin_sync,
    skills: items('skills'),
    mcps: items('mcps'),
  }
}

/** Loopback transport faults only: never fabricate an API response. */
export class TransportFaultProxy {
  constructor(target) {
    this.target = new URL(target)
    assert.equal(this.target.protocol, 'http:')
    assert.ok(['127.0.0.1', 'localhost'].includes(this.target.hostname))
    this.requests = []
    this.sockets = new Set()
    this.upstreams = new Set()
    this.websockets = new Set()
    this.deviceSockets = new Set()
    this.rule = () => null
    this.paused = false
    this.acknowledgementsPaused = false
    this.capabilitySyncGate = null
    this.server = createServer((request, response) => this.forward(request, response))
    this.server.on('connection', socket => this.track(socket))
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head))
  }

  track(socket) {
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.sockets.delete(socket))
  }

  options(request) {
    return {
      hostname: this.target.hostname,
      port: this.target.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: this.target.host },
    }
  }

  forward(request, response) {
    const url = new URL(request.url, this.target)
    // Retain no headers, tokens, request bodies or device query strings.
    const entry = { method: request.method, path: url.pathname, unscoped: !url.search }
    this.requests.push(entry)
    const fault = this.rule(entry)
    entry.fault = fault
    if (fault === 'hold-request') {
      request.resume()
      // A canceled destructive request must never be replayed when the fault is lifted.
      return
    }
    const upstream = httpRequest(this.options(request), incoming => {
      entry.status = incoming.statusCode
      if (fault === 'hold-response' || fault === 'drop-response') {
        const chunks = []
        incoming.on('data', chunk => chunks.push(chunk))
        incoming.once('end', () => {
          if (fault === 'drop-response') {
            response.destroy()
            entry.dropped = true
            return
          }
          entry.release = () =>
            new Promise(resolve => {
              response.once('finish', resolve)
              response.writeHead(incoming.statusCode, incoming.headers)
              response.end(Buffer.concat(chunks))
              entry.released = true
            })
          entry.committedResponseHeld = true
        })
        return
      }
      response.writeHead(incoming.statusCode, incoming.headers)
      incoming.pipe(response)
      response.once('finish', () => {
        entry.delivered = true
      })
    })
    this.upstreams.add(upstream)
    upstream.once('close', () => this.upstreams.delete(upstream))
    upstream.on('error', () => response.destroy())
    response.once('close', () => upstream.destroy())
    request.pipe(upstream)
  }

  upgrade(request, downstream, head) {
    const upstream = httpRequest(this.options(request))
    this.upstreams.add(upstream)
    upstream.once('close', () => this.upstreams.delete(upstream))
    upstream.on('error', () => downstream.destroy())
    downstream.once('close', () => upstream.destroy())
    upstream.once('response', response => {
      response.resume()
      downstream.destroy()
    })
    upstream.once('upgrade', (response, socket, upstreamHead) => {
      this.track(socket)
      this.websockets.add(socket)
      this.deviceSockets.add(downstream)
      socket.once('close', () => {
        this.websockets.delete(socket)
        downstream.destroy()
      })
      downstream.once('close', () => {
        this.deviceSockets.delete(downstream)
        socket.destroy()
      })
      const headers = response.rawHeaders.reduce((lines, value, index, all) => {
        if (index % 2 === 0) lines.push(`${value}: ${all[index + 1]}`)
        return lines
      }, [])
      downstream.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers.join('\r\n')}\r\n\r\n`
      )
      if (head.length) socket.write(head)
      if (upstreamHead.length) socket.unshift(upstreamHead)
      if (this.capabilitySyncGate) {
        const gate = this.capabilitySyncGate
        const delivery = new WebSocketMessageFilter(gate.receive)
        const acknowledgements = new WebSocketMessageFilter(gate.observeAcknowledgement)
        delivery.on('error', error => {
          gate.error = error
          downstream.destroy()
        })
        acknowledgements.on('error', error => {
          gate.error = error
          socket.destroy()
        })
        downstream.pipe(acknowledgements).pipe(socket)
        socket.pipe(delivery).pipe(downstream)
      } else {
        downstream.pipe(socket)
        socket.pipe(downstream)
      }
      if (this.paused) socket.pause()
      if (this.acknowledgementsPaused) downstream.pause()
    })
    upstream.end()
  }

  pauseDeviceDelivery(paused) {
    this.paused = paused
    for (const socket of this.websockets) {
      if (paused) socket.pause()
      else socket.resume()
    }
  }

  pauseDeviceAcknowledgements(paused) {
    this.acknowledgementsPaused = paused
    for (const socket of this.deviceSockets) {
      if (paused) socket.pause()
      else socket.resume()
    }
  }

  holdNextCapabilitySync(matches) {
    assert.equal(this.capabilitySyncGate, null, 'Only one capability delivery gate is allowed')
    let request
    let pending
    const gate = {
      held: null,
      acknowledgement: null,
      receive(text, frames, output) {
        if (gate.held) return false
        const candidate = capabilitySyncRequest(text)
        if (!candidate || !matches(candidate.payload)) return false
        request = candidate
        gate.held = {
          scope: candidate.payload.scope ?? 'all',
          pluginSync: candidate.payload.plugin_sync,
        }
        pending = { frames, output }
        return true
      },
      observeAcknowledgement(text) {
        if (request) gate.acknowledgement ??= capabilityAcknowledgement(text, request)
        return false
      },
      release() {
        if (pending && !pending.output.destroyed)
          for (const frame of pending.frames) pending.output.push(frame)
        pending = null
      },
    }
    this.capabilitySyncGate = gate
    return gate
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.url = `http://127.0.0.1:${this.server.address().port}`
    return this
  }

  async stop() {
    this.capabilitySyncGate?.release()
    for (const request of this.upstreams) request.destroy()
    for (const socket of this.sockets) socket.destroy()
    await new Promise((resolve, reject) =>
      this.server.close(error => (error ? reject(error) : resolve()))
    )
  }
}
