import { createServer } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { DshRuntime } from './dsh-runtime.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
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
})

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}
