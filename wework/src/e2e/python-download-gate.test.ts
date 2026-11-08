// @vitest-environment node
import { once } from 'node:events'
import { createServer as createHttpServer, request } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { afterEach, expect, test, vi } from 'vitest'
import { createPythonDownloadGate } from '../../e2e/desktop/modules/python-download-gate.mjs'

const route = vi.hoisted(() => vi.fn<(port: number, host: string, ready: () => void) => Socket>())
vi.mock('node:net', async importOriginal => ({
  ...(await importOriginal<object>()),
  connect: route,
}))
const { connect } = await vi.importActual<typeof import('node:net')>('node:net')
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release()
  route.mockReset()
})

test('holds GitHub CONNECT until release, then preserves every tunneled byte', async () => {
  const upstream = createTcpServer(socket => socket.pipe(socket))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  cleanup.push(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Missing echo server')
  route.mockImplementation((_port, _host, ready) => connect(address.port, '127.0.0.1', ready))
  const gate = await createPythonDownloadGate()
  cleanup.push(() => gate.stop())
  const client = connect(Number(new URL(gate.url).port), '127.0.0.1')
  cleanup.push(() => client.destroy())
  await once(client, 'connect')
  client.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n')
  await gate.waitForRequest(1000)
  expect(route).not.toHaveBeenCalled()
  const acknowledged = once(client, 'data')
  gate.release()
  expect(String((await acknowledged)[0])).toContain('200 Connection Established')
  expect(route).toHaveBeenCalledWith(443, 'github.com', expect.any(Function))
  const bytes = Buffer.from([0, 255, 22, 3, 1, 0, 9, 128])
  const echoed = once(client, 'data')
  client.write(bytes)
  expect((await echoed)[0]).toEqual(bytes)
})

test('forwards real HTTP login traffic while artifact TLS is held', async () => {
  const received: Buffer[] = []
  const upstream = createHttpServer((incoming, response) => {
    expect(incoming.url).toBe('/api/auth/wework/sessions')
    incoming.on('data', chunk => received.push(chunk))
    incoming.on('end', () => {
      response.writeHead(201)
      response.end('created')
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  cleanup.push(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTP server')
  const gate = await createPythonDownloadGate()
  cleanup.push(() => gate.stop())
  const body = '{"device_public_key":{"fixture":true}}'
  const reply = await new Promise<string>((resolve, reject) => {
    const client = request(
      gate.url,
      {
        method: 'POST',
        path: `http://127.0.0.1:${address.port}/api/auth/wework/sessions`,
        headers: { 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' },
      },
      response => {
        expect(response.statusCode).toBe(201)
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve(Buffer.concat(chunks).toString()))
      }
    )
    client.on('error', reject)
    client.end(body)
  })
  expect(reply).toBe('created')
  expect(Buffer.concat(received).toString()).toBe(body)
  expect(route).not.toHaveBeenCalled()
})
