import { createServer } from 'node:http'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DshRuntime } from './dsh-runtime.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve())
        })
    )
  )
})

describe('DSH runtime readiness', () => {
  test('preserves the timeout reason while a probe request is still in flight', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error('Probe request has no abort signal')
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(new DshRuntime({ url: 'http://127.0.0.1/pending' }).start(10)).rejects.toThrow(
      'DSH startup timed out'
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('does not treat a missing route as ready', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404)
      response.end()
    })
    servers.push(server)
    await listen(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP server has no port')

    await expect(
      new DshRuntime({ url: `http://127.0.0.1:${address.port}/missing` }).start(100)
    ).rejects.toThrow('DSH startup timed out')
  })

  test('requires every configured Core DSH endpoint', async () => {
    const ready = new Set(['/host', '/executor'])
    const server = createServer((request, response) => {
      response.writeHead(ready.has(request.url ?? '') ? 200 : 404)
      response.end()
    })
    servers.push(server)
    await listen(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const runtime = new DshRuntime({
      url: origin,
      probeUrls: [`${origin}/host`, `${origin}/executor`, `${origin}/terminal`],
    })

    const started = runtime.start(2_000)
    setTimeout(() => ready.add('/terminal'), 100)
    await expect(started).resolves.toBeUndefined()
  })

  test('uses the configured managed-process startup timeout', async () => {
    const runtime = new DshRuntime({
      url: 'http://127.0.0.1/pending',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      startTimeoutMs: 10,
    })

    await expect(runtime.start()).rejects.toThrow('dsh-web startup timed out')
    await runtime.stop()
  })
})

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}
