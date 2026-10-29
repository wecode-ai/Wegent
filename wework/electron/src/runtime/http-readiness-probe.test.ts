import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, expect, test } from 'vitest'
import { probeHttpReadiness } from './http-readiness-probe.js'

// Public test-only self-signed localhost fixture. This key is not used by any service.
const tlsKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCyusZtUJhfjjbQ
vrvgpLUtqXQutgaTHZmXnjf2lAwCYSqkvdArnWkYLRkQr1KA+2/JPC5m3ytT9v8u
CikHauU9HBleQ5cLZyLXy/SAEtjlcL1M4EHEY50K3iaZZTImldSNen78/920lheF
MbLqS87BuJhc8Q7D58BTJZ7vSOyr9Xx9sv7/gMl+WWKKj1nK71+BoCy0GTVBBmIF
gQ9sR0LyD5Yn8DtOLHrVqnLIcPjftMfBdAJ44g+6u/uC7kMKtZvKeg6NMCqxJtCs
wJnSswn/qOVuj+vP3WXgNGONvDX4NLfalXdoZSz0JqMoSsjdQNbI99pfN6ZwOFpP
z5C1Z1P1AgMBAAECggEACT1WnLgZ6Ha1prz1gXuCUkX8V53ZYSmakxf+1KR6qnTT
e4jEhjyw/ir2rMIjhb952/FchLzsxH50WrDzxgpkp3AYb6MW3+QJDRbiIOzYgaP+
ZUcCn2B28eTiIfP1T8FXJ6k5f2LK11cbCCu1kB8zJRih58wec0o7yxCa0sv2UD1e
fVKPsDfZOSLn6onxMf5m0vGURzx6B1VfZ37LQBTSdXZIoqOCGn4hawUugbzPrr7U
yEW1sC3LWsa1fDC20TmnHGao8rEA2PGGLywNrNNebVM7zEzlKIAewOICRz/Y9x4e
AFyX85IEuU8qvL7QvGx+HDN1gn0dpcaHD7wB2IyL0QKBgQDdG6rAlFJdNUZu1Nb5
0gqE1+GCecYETJUd9wwz2EXzHZkWOnrS6ej4IQJtKhb8o1PQCrwsgoyVu1yP7AC1
bSJxRmbnUfMGqLOBvBHbcJuE5ynwB7oUwerLPnCp6wrz0Zff6mBD2VHp4O8GHnuk
U5niP0YavVcbkRwHV8Qk/VByowKBgQDO7xmykoIJE0PV+xiCIWzNQ0D9ldj9SR2j
zU7er4D4Ab5GboFxAWmZltcOdxyFyj4+zwLyOvtxfdtR+2ikIyF/SoPJvHOUUgTA
1U/GejFEXPrLH3Qa9CkQblNaotWC6LjeGR3nrvbUM94lW0wo05viDHJzUeLzOq1W
bMfmsKeghwKBgA6MO3fgSmsHjlLMfjiBsV98NMI48OZng4gtMQhYOoH8eI4V2u71
pPZudZJpKooE1QbjLe5fyJAxe62cgY9uVs3NLAgcRDkz8Fug3CvsBM+Bxiic2Yl0
GNa2jQMhC99u8ucwrJTKP7F7sz5b0xbEyWMxdpNb0ddmfMme5LDqWdixAoGBAMAm
h48oufShXfE5evWDAhvL4nJWjaoMFai/gQgIodIpFD0kaa+8ZwlGZqW49tRJCumZ
ohu5pzgobNpAgFdBg95GG//crNpCGsXQjYY4er0HNZ4ds9s/c04dk+rqnyYy4U7i
tcEn120OSK4Zi6uxauNJOZFZrUq75q8Ezc6ppM3LAoGANlloa2z/It/Q7GGSRzm2
mNKSgatikdKcr0aZfSiIw7k4l9PyIhOte0cffifVfkRP65vpZDT/BWG0PBlrGqRo
7Z1yqZ18j3en9SUx39/rugEPwGyFRLTp93ZZ70lpDHKCxzpsdjCsRO9cIsEWSkrE
wyq67XT1TZPY5LKfPKwmxec=
-----END PRIVATE KEY-----`
const tlsCertificate = `-----BEGIN CERTIFICATE-----
MIICxTCCAa2gAwIBAgIJAIyPH3c/y6TZMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAgFw0yNjEwMjkwNjQxNTRaGA8yMTI2MTAwNTA2NDE1NFow
FDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEAsrrGbVCYX4420L674KS1Lal0LrYGkx2Zl5439pQMAmEqpL3QK51pGC0Z
EK9SgPtvyTwuZt8rU/b/LgopB2rlPRwZXkOXC2ci18v0gBLY5XC9TOBBxGOdCt4m
mWUyJpXUjXp+/P/dtJYXhTGy6kvOwbiYXPEOw+fAUyWe70jsq/V8fbL+/4DJflli
io9Zyu9fgaAstBk1QQZiBYEPbEdC8g+WJ/A7Tix61apyyHD437THwXQCeOIPurv7
gu5DCrWbynoOjTAqsSbQrMCZ0rMJ/6jlbo/rz91l4DRjjbw1+DS32pV3aGUs9Caj
KErI3UDWyPfaXzemcDhaT8+QtWdT9QIDAQABoxgwFjAUBgNVHREEDTALgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAH2SGtvkYRX6I9p3XutxV2KkQDtqxyxK
E+3jErRuYx+e9qN1XZQ0hHl0/JScBvymvE70qxaP9I/qB3aEukUEdgWJer3dxPKF
dtC/a/gVcc3ORP0C8R6/2p8DEXLFy8tvS0a9jte+5KYdlLFYZPrU2gw8tV0NQqTN
ocIQ2ZTMe1099foqNeps246fk4rC+1gyUe68MOq7xKPFPbaX+K6KkvkuTLNrfnrw
6PS0+q5aOTCwwNu6cBPczJFxL5CszWn744Q8g5yF5viSBchSJnfl8OD37aJ9ebq1
J9gvZd7f+1IZyAR7lTh86nBJ8SHs7yNjyLSTaNndR/PiIxGNJUuSyZM=
-----END CERTIFICATE-----`

type FixtureServer = Server | ReturnType<typeof createHttpsServer>
const servers: FixtureServer[] = []
const directories: string[] = []
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

async function listen(server: FixtureServer): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function childFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wework-http-readiness-'))
  directories.push(directory)
  const source = await readFile(new URL('./http-readiness-probe.ts', import.meta.url), 'utf8')
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
  })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  await writeFile(join(directory, 'probe.js'), outputText)
  await writeFile(join(directory, 'fixture-ca.pem'), tlsCertificate)
  await writeFile(
    join(directory, 'child.mjs'),
    `
    import assert from 'node:assert/strict'
    import { Socket } from 'node:net'
    import { probeHttpReadiness } from './probe.js'
    let tosCalls = 0
    if (process.env.PROBE_TOS_FAULT === '1') {
      Object.defineProperty(Socket.prototype, 'setTypeOfService', {
        configurable: true, writable: true, value() {
          tosCalls++
          const error = new Error('isolated test socket ToS fault')
          error.code = 'EINVAL'
          throw error
        },
      })
      assert.throws(() => new Socket().setTypeOfService(0), { code: 'EINVAL' })
      tosCalls = 0
      globalThis.fetch = () => { throw new Error('Readiness must not reach Node fetch') }
    }
    try {
      const result = await probeHttpReadiness(process.argv[2])
      console.log(JSON.stringify({ result, tosCalls, electron: Boolean(process.versions.electron) }))
    } catch (error) {
      console.log(JSON.stringify({ errorCode: error.code, errorName: error.name }))
      process.exitCode = 1
    }
  `
  )
  return directory
}

async function runChild(
  binary: string,
  directory: string,
  url: string,
  environment: NodeJS.ProcessEnv = {}
) {
  const env = { ...process.env, ...environment }
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  if (!Object.hasOwn(environment, 'ELECTRON_RUN_AS_NODE')) delete env.ELECTRON_RUN_AS_NODE
  let result: { stdout: string; stderr: string; status: number }
  try {
    result = {
      ...(await execFileAsync(
        binary,
        ['--dns-result-order=ipv4first', join(directory, 'child.mjs'), url],
        {
          env,
          timeout: 4_000,
        }
      )),
      status: 0,
    }
  } catch (error) {
    const failure = error as Error & { code: number | string; stdout: string; stderr: string }
    if (typeof failure.code !== 'number') throw error
    result = { status: failure.code, stdout: failure.stdout, stderr: failure.stderr }
  }
  return { ...result, output: JSON.parse(result.stdout.trim()) }
}

test.each([200, 204, 299, 300, 304, 404, 500])(
  'reports readiness only from HTTP status %i',
  async status => {
    const base = await listen(
      createServer((_request, response) => {
        response.writeHead(status)
        response.end()
      })
    )
    await expect(probeHttpReadiness(base)).resolves.toEqual({
      ok: status >= 200 && status < 300,
      status,
    })
  }
)

test('sends an anonymous GET to the original path and query', async () => {
  const received: Array<{
    method?: string
    url?: string
    cookie?: string
    authorization?: string
  }> = []
  const base = await listen(
    createServer((request, response) => {
      received.push({
        method: request.method,
        url: request.url,
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
      })
      response.end('ready')
    })
  )
  await probeHttpReadiness(`${base}/health?generation=2#client-fragment`)
  expect(received).toEqual([
    { method: 'GET', url: '/health?generation=2', cookie: undefined, authorization: undefined },
  ])
})

test.each([301, 302, 303, 307, 308])(
  'follows a relative Location for HTTP %i without credentials',
  async status => {
    const received: Array<{
      method?: string
      url?: string
      cookie?: string
      authorization?: string
    }> = []
    const base = await listen(
      createServer((request, response) => {
        received.push({
          method: request.method,
          url: request.url,
          cookie: request.headers.cookie,
          authorization: request.headers.authorization,
        })
        if (request.url === '/nested/start') {
          response.writeHead(status, {
            Location: '../ready?generation=2',
            'Set-Cookie': 'fixture-cookie=synthetic; Path=/',
          })
          response.end('redirect body')
        } else response.end('ready')
      })
    )
    await expect(probeHttpReadiness(`${base}/nested/start`)).resolves.toEqual({
      ok: true,
      status: 200,
    })
    expect(received).toEqual(
      ['/nested/start', '/ready?generation=2'].map(url => ({
        method: 'GET',
        url,
        cookie: undefined,
        authorization: undefined,
      }))
    )
  }
)

test('returns a redirect status without Location instead of following it', async () => {
  let count = 0
  const base = await listen(
    createServer((_request, response) => {
      count++
      response.writeHead(302)
      response.end()
    })
  )
  await expect(probeHttpReadiness(base)).resolves.toEqual({ ok: false, status: 302 })
  expect(count).toBe(1)
})

test.each([200, 300, 304, 305, 306])(
  'does not follow Location on non-redirect HTTP %i',
  async status => {
    let count = 0
    const base = await listen(
      createServer((_request, response) => {
        count++
        response.writeHead(status, { Location: '/must-not-be-requested' })
        response.end()
      })
    )
    await expect(probeHttpReadiness(base)).resolves.toEqual({ ok: status === 200, status })
    expect(count).toBe(1)
  }
)

test('accepts exactly twenty redirects and rejects the twenty-first', async () => {
  const paths: string[] = []
  const base = await listen(
    createServer((request, response) => {
      paths.push(request.url!)
      const remaining = Number(request.url!.slice(1))
      if (remaining > 0) response.writeHead(302, { Location: `/${remaining - 1}` })
      response.end()
    })
  )
  await expect(probeHttpReadiness(`${base}/20`)).resolves.toEqual({ ok: true, status: 200 })
  expect(paths).toHaveLength(21)
  expect(paths.at(-1)).toBe('/0')
  paths.length = 0
  await expect(probeHttpReadiness(`${base}/21`)).rejects.toThrow('exceeded 20 redirects')
  expect(paths).toHaveLength(21)
  expect(paths.at(-1)).toBe('/1')
})

test('bounds a redirect loop without waiting or retrying', async () => {
  let count = 0
  const base = await listen(
    createServer((_request, response) => {
      count++
      response.writeHead(307, { Location: '/' })
      response.end()
    })
  )
  await expect(probeHttpReadiness(base)).rejects.toThrow('exceeded 20 redirects')
  expect(count).toBe(21)
})

test.each(['file:///tmp/health', 'ftp://127.0.0.1/health', 'not a URL'])(
  'rejects unsupported readiness URL %s',
  async url => {
    await expect(probeHttpReadiness(url)).rejects.toBeInstanceOf(TypeError)
  }
)

test.each([
  ['username-only', 'fixture-user@'],
  ['password-only', ':fixture-password@'],
  ['username-and-password', 'fixture-user:fixture-password@'],
])(
  'rejects initial and redirected %s credentials before leaking Basic authorization',
  async (_name, credentials) => {
    const requests: Array<{ path?: string; authorization?: string }> = []
    const credentialUrl = (url: string) => url.replace('://', `://${credentials}`)
    const base = await listen(
      createServer((request, response) => {
        requests.push({ path: request.url, authorization: request.headers.authorization })
        response.writeHead(302, {
          Location: `${credentialUrl(base)}/blocked`,
        })
        response.end()
      })
    )
    await expect(probeHttpReadiness(credentialUrl(base))).rejects.toThrow('embedded credentials')
    expect(requests).toEqual([])
    await expect(probeHttpReadiness(base)).rejects.toThrow('embedded credentials')
    expect(requests).toEqual([{ path: '/', authorization: undefined }])
  }
)

test('rejects a redirect to a non-HTTP protocol', async () => {
  let count = 0
  const base = await listen(
    createServer((_request, response) => {
      count++
      response.writeHead(302, { Location: 'file:///tmp/health' })
      response.end()
    })
  )
  await expect(probeHttpReadiness(base)).rejects.toThrow('HTTP or HTTPS')
  expect(count).toBe(1)
})

test('preserves a pre-aborted reason without opening a connection', async () => {
  let count = 0
  const base = await listen(
    createServer((_request, response) => {
      count++
      response.end()
    })
  )
  const controller = new AbortController()
  const reason = { source: 'owned-test-cancellation' }
  controller.abort(reason)
  await expect(probeHttpReadiness(base, { signal: controller.signal })).rejects.toBe(reason)
  expect(count).toBe(0)
})

test.each([false, true])(
  'cancels an in-flight request after redirect=%s and preserves the reason',
  async redirect => {
    const paths: string[] = []
    let requestStarted!: () => void
    let connectionClosed!: () => void
    const started = new Promise<void>(resolve => {
      requestStarted = resolve
    })
    const closed = new Promise<void>(resolve => {
      connectionClosed = resolve
    })
    const base = await listen(
      createServer((request, response) => {
        paths.push(request.url!)
        if (redirect && request.url === '/') {
          response.writeHead(302, { Location: '/pending' })
          response.end()
          return
        }
        request.socket.once('close', connectionClosed)
        requestStarted()
      })
    )
    const controller = new AbortController()
    const reason = new Error('owned readiness cancelled')
    const operation = probeHttpReadiness(base, { signal: controller.signal })
    await started
    controller.abort(reason)
    await expect(operation).rejects.toBe(reason)
    await closed
    expect(paths).toEqual(redirect ? ['/', '/pending'] : ['/'])
  }
)

test('rejects a peer reset before response headers without an unhandled error', async () => {
  const base = await listen(createServer(request => request.socket.destroy()))
  await expect(probeHttpReadiness(base)).rejects.toMatchObject({ code: 'ECONNRESET' })
})

test('releases the socket after headers even when the response body never finishes', async () => {
  let connectionClosed!: () => void
  const closed = new Promise<void>(resolve => {
    connectionClosed = resolve
  })
  const base = await listen(
    createServer((request, response) => {
      request.socket.once('close', connectionClosed)
      response.writeHead(200, { 'Content-Length': '1000000' })
      response.write('partial body')
    })
  )
  await expect(probeHttpReadiness(base)).resolves.toEqual({ ok: true, status: 200 })
  await closed
})

test('keeps HTTPS verification enabled and trusts only the child fixture CA', async () => {
  const serverNames: Array<string | false | undefined> = []
  const server = createHttpsServer({ key: tlsKey, cert: tlsCertificate }, (request, response) => {
    serverNames.push((request.socket as import('node:tls').TLSSocket).servername)
    response.end('ready')
  })
  server.on('tlsClientError', () => {})
  const base = (await listen(server)).replace('http:', 'https:')
  await expect(probeHttpReadiness(base)).rejects.toMatchObject({
    code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  })
  const directory = await childFixture()
  const environment = { NODE_EXTRA_CA_CERTS: join(directory, 'fixture-ca.pem') }
  const trusted = await runChild(
    process.execPath,
    directory,
    base.replace('127.0.0.1', 'localhost'),
    environment
  )
  expect(trusted.status).toBe(0)
  expect(trusted.output.result).toEqual({ ok: true, status: 200 })
  expect(serverNames).toEqual(['localhost'])
  const redirect = await listen(
    createServer((_request, response) => {
      response.writeHead(302, { Location: base.replace('127.0.0.1', 'localhost') })
      response.end()
    })
  )
  const upgraded = await runChild(process.execPath, directory, redirect, environment)
  expect(upgraded.status).toBe(0)
  expect(upgraded.output.result).toEqual({ ok: true, status: 200 })
  expect(serverNames).toEqual(['localhost', 'localhost'])
  const mismatch = await runChild(process.execPath, directory, base, environment)
  expect(mismatch.status).toBe(1)
  expect(mismatch.output.errorCode).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
  expect(serverNames).toEqual(['localhost', 'localhost'])
})

test.each(['node', 'electron'])(
  'the real %s host probes HTTP under an isolated socket ToS fault',
  async host => {
    const requests: string[] = []
    const base = await listen(
      createServer((request, response) => {
        requests.push(request.url!)
        response.end('ready')
      })
    )
    const directory = await childFixture()
    const binary = host === 'electron' ? (require('electron') as string) : process.execPath
    const result = await runChild(binary, directory, `${base}/ready`, {
      PROBE_TOS_FAULT: '1',
      ...(host === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.output).toEqual({
      result: { ok: true, status: 200 },
      tosCalls: 0,
      electron: host === 'electron',
    })
    expect(requests).toEqual(['/ready'])
  }
)
