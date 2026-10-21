import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'

/** Loopback transport faults only: never fabricate a plugin API response. */
export class PluginFaultProxy {
  constructor(target) {
    this.target = new URL(target)
    assert.equal(this.target.protocol, 'http:')
    assert.ok(['127.0.0.1', 'localhost'].includes(this.target.hostname))
    this.requests = []
    this.sockets = new Set()
    this.upstreams = new Set()
    this.websockets = new Set()
    this.delayedResponses = new Map()
    this.nextDelayedResponseId = 1
    this.rule = () => null
    this.paused = false
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
    const requestId = request.headers['x-request-id']
    if (typeof requestId === 'string') {
      entry.requestIdFingerprint = createHash('sha256').update(requestId).digest('hex')
    }
    this.requests.push(entry)
    response.once('finish', () => {
      entry.responseCompleted = true
    })
    const fault = this.rule(entry)
    entry.fault = fault
    if (fault === 'disconnect') {
      request.resume()
      response.destroy()
      return
    }
    if (fault === 'hold-request') {
      request.resume()
      // A canceled destructive request must never be replayed when the fault is lifted.
      return
    }
    const upstream = httpRequest(this.options(request), incoming => {
      entry.status = incoming.statusCode
      if (fault === 'delay-response') {
        const chunks = []
        incoming.on('data', chunk => chunks.push(chunk))
        incoming.once('end', () => {
          if (response.destroyed) return
          entry.delayedResponseId = this.nextDelayedResponseId++
          entry.delayedResponseReady = true
          this.delayedResponses.set(entry.delayedResponseId, {
            entry,
            response,
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          })
        })
        response.once('close', () => {
          if (entry.delayedResponseId) this.delayedResponses.delete(entry.delayedResponseId)
        })
        return
      }
      if (fault === 'hold-response' || fault === 'drop-response') {
        incoming.resume()
        incoming.once('end', () => {
          if (fault === 'drop-response') {
            entry.committedResponseDropped = true
            response.destroy()
          } else {
            entry.committedResponseHeld = true
          }
        })
        return
      }
      response.writeHead(incoming.statusCode, incoming.headers)
      incoming.pipe(response)
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
      socket.once('close', () => {
        this.websockets.delete(socket)
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
      if (head.length) socket.write(head)
      if (upstreamHead.length) socket.unshift(upstreamHead)
      downstream.pipe(socket)
      socket.pipe(downstream)
      if (this.paused) socket.pause()
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

  /** Release exact completed upstream replies; never reissue their requests. */
  releaseDelayedResponses(predicate = () => true) {
    let released = 0
    for (const [id, delayed] of this.delayedResponses) {
      if (!predicate(delayed.entry)) continue
      this.delayedResponses.delete(id)
      if (delayed.response.destroyed) continue
      delayed.entry.delayedResponseReleased = true
      delayed.response.writeHead(delayed.status, delayed.headers)
      delayed.response.end(delayed.body)
      released += 1
    }
    return released
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
    for (const { response } of this.delayedResponses.values()) response.destroy()
    this.delayedResponses.clear()
    for (const request of this.upstreams) request.destroy()
    for (const socket of this.sockets) socket.destroy()
    await new Promise((resolve, reject) =>
      this.server.close(error => (error ? reject(error) : resolve()))
    )
  }
}
