import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { HostCapabilityRouter } from '../host/capability-router.js'
import { HostPipeServer } from '../host/host-pipe.js'
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

describe('DSH host session ownership', () => {
  test('M3-D: a stale runtime stop keeps the current host session attached', async () => {
    const httpServer = createServer((_request, response) => {
      response.writeHead(200)
      response.end()
    })
    servers.push(httpServer)
    await listen(httpServer)
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('HTTP server has no port')
    const origin = `http://127.0.0.1:${address.port}`

    const router = new HostCapabilityRouter()
    router.grant('@wegent/dsh-app-wework', ['window.getState'])
    router.register('window.getState', async () => ({ maximized: false }))
    const hostPipe = new HostPipeServer(router)

    const stale = new DshRuntime({
      url: origin,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      probeUrls: [origin],
      startTimeoutMs: 2_000,
      hostPipe,
    })
    await stale.start()

    // The new generation attaches its own session, replacing the stale child.
    const currentToHost = new PassThrough()
    const hostToCurrent = new PassThrough()
    const replies = createInterface({ input: hostToCurrent })
    const nextReply = () =>
      new Promise<Record<string, unknown>>(resolve =>
        replies.once('line', line => resolve(JSON.parse(line) as Record<string, unknown>))
      )
    hostPipe.attachStreams(currentToHost, hostToCurrent)

    // Old generation cleanup resumes: it must not detach the new session.
    await stale.stop()

    const reply = nextReply()
    currentToHost.write(
      `${JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token: hostPipe.environment().WEWORK_ELECTRON_HOST_TOKEN,
        principal: '@wegent/dsh-app-wework',
      })}\n`
    )
    await expect(reply).resolves.toMatchObject({ type: 'hello', ok: true })
    hostPipe.stop()
  })
})
