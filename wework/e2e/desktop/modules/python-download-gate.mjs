import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { until } from './plugin-regression-fixture.mjs'

/** Pause real GitHub TLS connections; never decrypt, replace or cache artifact bytes. */
export async function createPythonDownloadGate() {
  const sockets = new Set()
  let waiting = 0
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const track = socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    return socket
  }
  const server = createServer((request, response) => {
    const target = new URL(request.url)
    const upstream = httpRequest(
      target,
      {
        method: request.method,
        headers: request.headers,
      },
      incoming => {
        response.writeHead(incoming.statusCode, incoming.headers)
        incoming.pipe(response)
      }
    )
    upstream.on('error', () => response.destroy())
    upstream.on('socket', track)
    response.once('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on('connection', track)
  server.on('connect', (request, socket, head) => {
    const target = new URL(`https://${request.url}`)
    const forward = () => {
      if (socket.destroyed) return
      const upstream = track(
        connect(Number(target.port || 443), target.hostname, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          socket.pipe(upstream).pipe(socket)
        })
      )
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
    }
    if (target.hostname === 'github.com') {
      waiting++
      void gate.then(forward)
    } else forward()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}`,
    waitForRequest: timeoutMs =>
      until(
        () => waiting,
        count => count > 0,
        'Login did not resume the demanded real Python download',
        timeoutMs
      ),
    release,
    async stop() {
      release()
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
