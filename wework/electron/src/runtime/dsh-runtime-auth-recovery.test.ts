import type { Cookie, Session } from 'electron'
import { afterEach, expect, test, vi } from 'vitest'
import { copyDshBrowserAuthentication, dshBrowserRequestHeaders } from './dsh-browser-auth.js'
import { DshRuntime } from './dsh-runtime.js'
import { RuntimeSupervisor } from './runtime-supervisor.js'

const electron = vi.hoisted(() => ({
  cookies: new Map<string, Cookie>(),
  fetch: vi.fn<typeof fetch>(),
}))
vi.mock('electron', () => ({
  session: {
    defaultSession: {
      cookies: {
        get: async (filter: { name?: string }) =>
          [...electron.cookies.values()].filter(
            cookie => !filter.name || cookie.name === filter.name
          ),
        remove: async (_url: string, name: string) => {
          electron.cookies.delete(name)
        },
      },
      fetch: electron.fetch,
    },
  },
}))

const runtimes: DshRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()))
  electron.cookies.clear()
  electron.fetch.mockReset()
})

test.each(['1', 'legacy'])(
  'restores the existing WebView with the replacement process credential in %s mode',
  async mode => {
    const runtime = managedRuntime(mode)
    const target = browserSession()
    await runtime.start()
    const url = runtime.url()
    const source = {
      cookies: {
        get: async (filter: { name: string }) =>
          [...electron.cookies.values()].filter(cookie => cookie.name === filter.name),
      },
    } as unknown as Session
    await copyDshBrowserAuthentication(source, target.session, url)
    const firstCookie = [...target.cookies.values()][0]
    const originalPid = runtime.pid()!
    expect(await browserStatus(url, target.cookies)).toBe(200)

    process.kill(originalPid, 'SIGKILL')
    await vi.waitFor(async () => {
      expect(runtime.pid()).not.toBeNull()
      expect(runtime.pid()).not.toBe(originalPid)
      expect([...target.cookies.values()][0]?.value).toBe(String(runtime.pid()))
      expect(await browserStatus(url, target.cookies)).toBe(200)
    })

    expect(runtime.url()).toBe(url)
    expect([...target.cookies.values()][0].value).not.toBe(firstCookie.value)
    await runtime.stop()
    expect(electron.cookies.size).toBe(0)
    expect(target.cookies.size).toBe(0)
  }
)

test('reclaims a cookie accepted before the authentication redirect fails', async () => {
  const runtime = managedRuntime('1')
  const exchange = electron.fetch.getMockImplementation()!
  electron.fetch.mockImplementationOnce(async (input, init) => {
    await exchange(input, init)
    throw new Error('bootstrap redirect interrupted')
  })
  await expect(runtime.start()).rejects.toThrow('bootstrap redirect interrupted')
  expect(electron.cookies.size).toBe(1)
  await runtime.stop()
  expect(electron.cookies.size).toBe(0)
})

test.each(['stop', 'cleanup', 'both'] as const)(
  'reclaims authentication and preserves error precedence when %s fails',
  async failure => {
    const runtime = managedRuntime('1')
    const target = browserSession()
    await runtime.start()
    const source = (await import('electron')).session.defaultSession
    await copyDshBrowserAuthentication(source, target.session, runtime.url())
    expect(electron.cookies.size).toBe(1)
    expect(target.cookies.size).toBe(1)
    const stopError = new Error('runtime log flush failed')
    const cleanupError = new Error('cookie removal failed')
    const stop = RuntimeSupervisor.prototype.stop
    const stopping = vi
      .spyOn(RuntimeSupervisor.prototype, 'stop')
      .mockImplementation(async function () {
        await stop.call(this)
        if (failure !== 'cleanup') throw stopError
      })
    const removing = vi.spyOn(source.cookies, 'remove')
    if (failure !== 'stop') removing.mockRejectedValueOnce(cleanupError)
    const logging = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const stopped = runtime.stop()
      if (failure === 'cleanup') {
        await expect(stopped).rejects.toMatchObject({
          message: 'DSH cookie cleanup failed',
          errors: [cleanupError],
        })
      } else {
        await expect(stopped).rejects.toBe(stopError)
      }
      expect(removing).toHaveBeenCalledTimes(1)
      expect(electron.cookies.size).toBe(failure === 'stop' ? 0 : 1)
      expect(target.cookies.size).toBe(0)
      expect(logging).toHaveBeenCalledTimes(failure === 'both' ? 1 : 0)
    } finally {
      stopping.mockRestore()
      removing.mockRestore()
      logging.mockRestore()
      await runtime.stop()
    }
    expect(electron.cookies.size).toBe(0)
  }
)

test('waits for an aborted authentication attempt before reclaiming its cookies', async () => {
  const runtime = managedRuntime('1')
  const exchange = electron.fetch.getMockImplementation()!
  let accepted!: () => void
  const cookieAccepted = new Promise<void>(resolve => {
    accepted = resolve
  })
  electron.fetch.mockImplementationOnce(async (input, init) => {
    await exchange(input, init)
    accepted()
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) throw new Error('Missing authentication abort signal')
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  })
  const starting = runtime.start()
  const rejected = expect(starting).rejects.toThrow()
  await Promise.race([cookieAccepted, starting])
  expect(electron.cookies.size).toBe(1)
  await runtime.stop()
  await rejected
  expect(electron.cookies.size).toBe(0)
})

test('reclaims both sessions when supervised recovery reaches its terminal failure state', async () => {
  const runtime = managedRuntime('1')
  const target = browserSession()
  await runtime.start()
  const source = {
    cookies: {
      get: async (filter: { name: string }) =>
        [...electron.cookies.values()].filter(cookie => cookie.name === filter.name),
    },
  } as unknown as Session
  await copyDshBrowserAuthentication(source, target.session, runtime.url())

  for (let crash = 0; crash < 4; crash++) {
    const previousPid = runtime.pid()!
    process.kill(previousPid, 'SIGKILL')
    if (crash < 3) {
      await vi.waitFor(
        async () => {
          expect(runtime.pid()).not.toBeNull()
          expect(runtime.pid()).not.toBe(previousPid)
          expect([...target.cookies.values()][0]?.value).toBe(String(runtime.pid()))
          expect(await browserStatus(runtime.url(), target.cookies)).toBe(200)
        },
        { timeout: 3000 }
      )
    }
  }
  await vi.waitFor(() => {
    expect(runtime.pid()).toBeNull()
    expect(electron.cookies.size).toBe(0)
    expect(target.cookies.size).toBe(0)
  })
}, 10000)

function managedRuntime(mode: string): DshRuntime {
  electron.fetch.mockImplementation(async (input, init = {}) => {
    const url = String(input)
    const response = await fetch(url, {
      ...init,
      headers: dshBrowserRequestHeaders(url, {
        Cookie: [...electron.cookies.values()]
          .map(cookie => `${cookie.name}=${cookie.value}`)
          .join('; '),
      }),
    })
    const raw = response.headers.get('set-cookie')
    if (raw) {
      const pair = raw.split(';')[0]
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator)
      electron.cookies.set(name, {
        name,
        value: pair.slice(separator + 1),
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false,
        session: true,
        sameSite: 'strict',
      })
    }
    return response
  })
  const runtime = new DshRuntime({
    url: 'http://127.0.0.1:0/',
    command: process.execPath,
    args: [
      '-e',
      `
      const http = require('node:http')
      const crypto = require('node:crypto')
      const fs = require('node:fs')
      const port = Number(process.argv[process.argv.indexOf('--port') + 1])
      const server = http.createServer((req, res) => {
        const host = '127.0.0.1:' + server.address().port
        const name = 'dsh-auth-' + crypto.createHash('sha256').update(host).digest('base64url')
        if (req.url === '/?token=fixture') {
          res.writeHead(204, { 'Set-Cookie': name + '=' + process.pid + '; Path=/; HttpOnly' })
        } else {
          res.writeHead((req.headers.cookie || '').includes(name + '=' + process.pid) ? 200 : 401)
        }
        res.end()
      })
      server.listen(port, '127.0.0.1', () => {
        const url = 'http://127.0.0.1:' + server.address().port
        console.log('dsh web: ' + url)
        fs.writeSync(5, JSON.stringify({ url: url + '/?token=fixture' }) + '\\n')
      })
    `,
      '--',
      '--port',
      '0',
    ],
    env: { ...process.env, WEWORK_DSH_BROWSER_AUTH: mode },
    startTimeoutMs: 2000,
  })
  runtimes.push(runtime)
  return runtime
}

function browserSession() {
  const cookies = new Map<string, Cookie>()
  const session = {
    cookies: {
      get: async (filter: { name?: string }) =>
        [...cookies.values()].filter(cookie => !filter.name || cookie.name === filter.name),
      set: async (cookie: Cookie) => {
        cookies.set(cookie.name, { ...cookie, domain: '127.0.0.1' })
      },
      remove: async (_url: string, name: string) => {
        cookies.delete(name)
      },
    },
  } as unknown as Session
  return { cookies, session }
}

async function browserStatus(url: string, cookies: Map<string, Cookie>) {
  const response = await fetch(url, {
    headers: dshBrowserRequestHeaders(url, {
      Cookie: [...cookies.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    }),
  })
  await response.arrayBuffer()
  return response.status
}
