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
  test.each(['stdout', 'pipe'])('discovers the child-bound port through %s', async transport => {
    const authenticateBrowserSession = vi.fn(async () => {})
    const onRestarted = vi.fn(async () => {})
    const hostPipe = new HostPipeServer(new HostCapabilityRouter())
    const runtime = new DshRuntime({
      url: 'http://127.0.0.1:0',
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => {
          if (request.url === '/?token=fixture-token') {
            response.writeHead(303, { location: '/', 'set-cookie': 'fixture=authenticated' })
          } else {
            response.writeHead(request.headers.cookie === 'fixture=authenticated' ? 200 : 401)
          }
          response.end()
        })
        server.listen(0, '127.0.0.1', () => {
          const url = 'http://127.0.0.1:' + server.address().port + '/?token=fixture-token'
          if (process.env.ENDPOINT_TRANSPORT === 'stdout') {
            console.log('dsh web: ' + url)
          } else {
            import('node:fs').then(async fs => {
              const { createInterface } = await import('node:readline')
              const input = fs.createReadStream(null, { fd: 3, autoClose: false })
              const output = fs.createWriteStream(null, { fd: 4, autoClose: false })
              const send = value => output.write(JSON.stringify(value) + '\\n')
              createInterface({ input }).on('line', line => {
                if (JSON.parse(line).type === 'hello') send({ type: 'runtimeEndpoint', url })
              })
              send({ type: 'hello', protocolVersion: 1,
                token: process.env.WEWORK_ELECTRON_HOST_TOKEN, principal: '@wegent/dsh-app-wework' })
            })
            setTimeout(() => console.log('dsh web: ' + url), 3000)
          }
        })
      `,
      ],
      probeUrls: ['http://127.0.0.1:0/host', 'http://127.0.0.1:0/executor'],
      startTimeoutMs: 1000,
      authenticateBrowserSession,
      onRestarted,
      hostPipe,
      env: { ...process.env, ...hostPipe.environment(), ENDPOINT_TRANSPORT: transport },
    })
    try {
      await runtime.start()
      const origin = runtime.url()
      expect(Number(new URL(origin).port)).toBeGreaterThan(0)
      expect(authenticateBrowserSession).toHaveBeenCalledWith(
        `${origin}/?token=fixture-token`,
        'fixture=authenticated'
      )
      for (const path of ['/host', '/executor']) {
        const response = await fetch(`${origin}${path}`, {
          headers: { cookie: 'fixture=authenticated' },
        })
        expect(response.ok).toBe(true)
      }
      expect(onRestarted).not.toHaveBeenCalled()
      const pid = runtime.pid()
      if (!pid) throw new Error('The managed runtime has no process')
      process.kill(pid, 'SIGKILL')
      await vi.waitFor(() => expect(onRestarted).toHaveBeenCalledOnce(), { timeout: 2000 })
      expect(runtime.pid()).not.toBe(pid)
      expect(Number(new URL(runtime.url()).port)).toBeGreaterThan(0)
    } finally {
      await runtime.stop()
    }
  })

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

  test('checks independent readiness routes without waiting for an earlier route', async () => {
    const requested = new Set<string>()
    let releaseHost: (() => void) | undefined
    const server = createServer((request, response) => {
      requested.add(request.url ?? '')
      if (request.url === '/host') releaseHost = () => response.end('ready')
      else response.end('ready')
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
    let ready = false
    const started = runtime.start(2_000).then(() => {
      ready = true
    })
    try {
      await vi.waitFor(
        () => expect(requested).toEqual(new Set(['/host', '/executor', '/terminal'])),
        { timeout: 500 }
      )
      expect(ready).toBe(false)
    } finally {
      releaseHost?.()
      await started
      await runtime.stop()
    }
    expect(ready).toBe(true)
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

  test.each([false, true])(
    'authenticates clean readiness URLs (transient failure=%s)',
    async transientFailure => {
      let exchanges = 0
      const server = createServer((request, response) => {
        if (request.url === '/?token=fixture-token') {
          exchanges += 1
          if (transientFailure && exchanges === 1) {
            response.writeHead(503)
          } else {
            response.writeHead(303, {
              location: '/',
              'set-cookie': 'fixture=authenticated; HttpOnly',
            })
          }
        } else {
          response.writeHead(request.headers.cookie === 'fixture=authenticated' ? 200 : 401)
        }
        response.end()
      })
      servers.push(server)
      await listen(server)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('HTTP server has no port')
      const origin = `http://127.0.0.1:${address.port}`
      const authenticateBrowserSession = vi.fn(async () => {})
      const runtime = new DshRuntime({
        url: origin,
        command: process.execPath,
        args: [
          '-e',
          `console.log('dsh web: ${origin}/?token=fixture-token'); setInterval(() => {}, 1000)`,
        ],
        probeUrls: [origin, `${origin}/api-ready`],
        startTimeoutMs: 2000,
        authenticateBrowserSession,
      })
      try {
        await runtime.start()
        expect(exchanges).toBe(transientFailure ? 2 : 1)
        expect(authenticateBrowserSession).toHaveBeenCalledWith(
          `${origin}/?token=fixture-token`,
          'fixture=authenticated'
        )
        expect(runtime.url()).toBe(origin)
      } finally {
        await runtime.stop()
      }
    }
  )
})

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

describe('DSH host session ownership', () => {
  test('stale runtime cleanup cannot detach the current child host session', async () => {
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
