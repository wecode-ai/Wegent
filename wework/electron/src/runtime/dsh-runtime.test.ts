import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { loopbackFetch } from '../../test/fixtures/loopback-fetch.mjs'
import { HostCapabilityRouter } from '../host/capability-router.js'
import { HostPipeServer } from '../host/host-pipe.js'
import { DshRuntime } from './dsh-runtime.js'

const { browserFetch, netFetch } = vi.hoisted(() => ({
  browserFetch: vi.fn(),
  netFetch: vi.fn(),
}))
vi.mock('electron', () => ({
  net: { fetch: netFetch },
  session: { defaultSession: { fetch: browserFetch } },
}))

const servers: Array<ReturnType<typeof createServer>> = []

beforeEach(() => {
  netFetch.mockImplementation(loopbackFetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  netFetch.mockReset()
  browserFetch.mockReset()
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
  test('uses Chromium without session credentials and forwards HTTPS URLs and abort signals', async () => {
    const nodeFetch = vi.fn(() => {
      throw new Error('Anonymous readiness must not use Node fetch')
    })
    vi.stubGlobal('fetch', nodeFetch)
    netFetch.mockResolvedValueOnce(new Response('', { status: 200 }))
    const url = 'https://runtime.example.test/health?generation=2'

    await new DshRuntime({ url }).start()

    expect(netFetch).toHaveBeenCalledExactlyOnceWith(url, {
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    })
    expect(netFetch.mock.calls[0][1].signal.aborted).toBe(false)
    expect(browserFetch).not.toHaveBeenCalled()
    expect(nodeFetch).not.toHaveBeenCalled()
  })

  test.each(['before', 'after'])(
    'authenticates a dynamically bound port with credentials sent %s its announcement',
    async order => {
      browserFetch.mockImplementation(loopbackFetch)
      const runtime = new DshRuntime({
        url: 'http://127.0.0.1:0/',
        command: process.execPath,
        args: [
          '-e',
          `
          const http = require('node:http')
          const fs = require('node:fs')
          let authenticated = false
          const server = http.createServer((request, response) => {
            if (request.url === '/?token=private-test-token') authenticated = true
            response.writeHead(authenticated ? 200 : 401)
            response.end()
          })
          server.listen(0, '127.0.0.1', () => {
            const url = 'http://127.0.0.1:' + server.address().port
            const credential = () => fs.writeSync(5, JSON.stringify({url: url + '/?token=private-test-token'}) + '\\n')
            if (${JSON.stringify(order)} === 'before') credential()
            console.log('dsh web: ' + url + '/?token=private-test-token')
            if (${JSON.stringify(order)} === 'after') setImmediate(credential)
          })
        `,
        ],
        probeUrls: ['http://127.0.0.1:0/host', 'http://127.0.0.1:0/executor'],
        env: { ...process.env, WEWORK_DSH_BROWSER_AUTH: '1' },
        startTimeoutMs: 2_000,
      })
      try {
        await runtime.start()
        const origin = new URL(runtime.url()).origin
        expect(Number(new URL(origin).port)).toBeGreaterThan(0)
        expect(browserFetch.mock.calls.map(([url]) => url)).toEqual([
          origin + '/?token=private-test-token',
          origin + '/host',
          origin + '/executor',
        ])
        expect(runtime.url()).not.toContain('token')
        expect(netFetch).not.toHaveBeenCalled()
      } finally {
        await runtime.stop()
        browserFetch.mockReset()
      }
    }
  )

  test('exchanges a private pipe credential before probing with the Electron session', async () => {
    browserFetch.mockResolvedValue(new Response('', { status: 200 }))
    const url = 'http://127.0.0.1:12345/'
    const runtime = new DshRuntime({
      url,
      command: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeSync(5, JSON.stringify({url:'http://127.0.0.1:12345/?token=private-test-token'}) + '\\n'); setInterval(() => {}, 1000)",
      ],
      env: { ...process.env, WEWORK_DSH_BROWSER_AUTH: '1' },
    })
    try {
      await runtime.start()
      expect(browserFetch.mock.calls.map(([input]) => input)).toEqual([
        url + '?token=private-test-token',
        url,
      ])
      expect(runtime.url()).toBe(url)
    } finally {
      await runtime.stop()
      browserFetch.mockReset()
    }
  })

  test('rejects a pipe credential for a different origin before any browser request', async () => {
    const runtime = new DshRuntime({
      url: 'http://127.0.0.1:12345/',
      command: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeSync(5, JSON.stringify({url:'https://example.com/?token=private-test-token'}) + '\\n'); setInterval(() => {}, 1000)",
      ],
      env: { ...process.env, WEWORK_DSH_BROWSER_AUTH: '1' },
    })
    try {
      await expect(runtime.start()).rejects.toThrow('Invalid DSH browser authentication response')
      expect(browserFetch).not.toHaveBeenCalled()
    } finally {
      await runtime.stop()
    }
  })

  test('concurrent managed runtimes bind their own ports and probe their advertised endpoints', async () => {
    const runtimes = Array.from(
      { length: 2 },
      () =>
        new DshRuntime({
          url: 'http://127.0.0.1:0',
          command: process.execPath,
          args: [
            '-e',
            `
              const http = require('node:http')
              const requests = []
              const server = http.createServer((request, response) => {
                requests.push(request.url)
                response.end(JSON.stringify(requests))
              })
              server.listen(0, '127.0.0.1', () => {
                process.stdout.write('dsh web: http://127.0.0.1:')
                setImmediate(() => process.stdout.write(server.address().port + '\\n'))
              })
            `,
          ],
          probeUrls: ['http://127.0.0.1:0/host', 'http://127.0.0.1:0/executor'],
          startTimeoutMs: 2_000,
        })
    )
    try {
      await Promise.all(runtimes.map(runtime => runtime.start()))
      expect(runtimes[0].url()).not.toBe(runtimes[1].url())
      for (const runtime of runtimes) {
        expect(Number(new URL(runtime.url()).port)).toBeGreaterThan(0)
        const response = await loopbackFetch(`${runtime.url()}/requests`)
        expect(await response.json()).toEqual(['/host', '/executor', '/requests'])
      }
      expect(netFetch.mock.calls.length).toBeGreaterThan(0)
      for (const [, init] of netFetch.mock.calls) {
        expect(init.credentials).toBe('omit')
        expect(init.signal).toBeInstanceOf(AbortSignal)
      }
    } finally {
      await Promise.all(runtimes.map(runtime => runtime.stop()))
    }
  })

  test('a managed runtime cannot become ready without announcing its bound port', async () => {
    const runtime = new DshRuntime({
      url: 'http://127.0.0.1:0',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      startTimeoutMs: 100,
    })
    try {
      await expect(runtime.start()).rejects.toThrow('dsh-web startup timed out')
      expect(runtime.url()).toBe('http://127.0.0.1:0')
    } finally {
      await runtime.stop()
    }
  })

  test('a crashed managed runtime restores its original listening address', async () => {
    const runtime = new DshRuntime({
      url: 'http://127.0.0.1:0',
      command: process.execPath,
      args: [
        '-e',
        `
          const http = require('node:http')
          const port = Number(process.argv[process.argv.indexOf('--port') + 1])
          const server = http.createServer((_request, response) => {
            response.end(String(process.pid))
          })
          server.listen(port, '127.0.0.1', () => {
            console.log('dsh web: http://127.0.0.1:' + server.address().port)
          })
        `,
        '--',
        '--port',
        '0',
      ],
      startTimeoutMs: 2_000,
    })
    try {
      await runtime.start()
      const origin = runtime.url()
      const firstPid = runtime.pid()
      if (!firstPid) throw new Error('Managed DSH process has no PID')
      process.kill(firstPid, 'SIGKILL')
      await vi.waitFor(
        async () => {
          const response = await loopbackFetch(origin)
          expect(Number(await response.text())).not.toBe(firstPid)
        },
        { timeout: 3_000 }
      )
      expect(runtime.url()).toBe(origin)
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
    netFetch.mockImplementation(fetchMock)

    await expect(new DshRuntime({ url: 'http://127.0.0.1/pending' }).start(10)).rejects.toThrow(
      'DSH startup timed out'
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]).toEqual({
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
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
