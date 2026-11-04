import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { request } from 'node:http'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

let child: ChildProcess | undefined

afterEach(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
})

async function start(failFirstConnection = false) {
  child = spawn(
    process.execPath,
    [
      '--require',
      fileURLToPath(new URL('./legacy-dsh-browser-auth.cjs', import.meta.url)),
      '-e',
      `
      const server = require('node:http').createServer((req, res) => res.end('application'))
      server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: close\\r\\n\\r\\n'))
      if (${JSON.stringify(failFirstConnection)}) server.once('connection', socket => {
        socket.once('data', () => queueMicrotask(() => socket.destroy(new Error('Peer disconnected during rejection'))))
      })
      server.listen(0, '127.0.0.1')
    `,
    ],
    {
      env: { ...process.env, WEWORK_DSH_BROWSER_AUTH_FD: '5' },
      stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore', 'pipe'],
    }
  )
  const lines = createInterface({ input: child.stdio[5] as Readable })
  const [line] = await once(lines, 'line')
  lines.close()
  const bootstrap = new URL(JSON.parse(line).url)
  return { bootstrap, origin: bootstrap.origin }
}

async function authenticate(bootstrap: URL) {
  const response = await fetch(bootstrap, { redirect: 'manual' })
  expect(response.status).toBe(204)
  const cookie = response.headers.get('set-cookie')!
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  expect(response.headers.get('cache-control')).toBe('no-store')
  return cookie.split(';')[0]
}

async function upgrade(origin: string, headers: Record<string, string> = {}) {
  const url = new URL(origin)
  const socket = createConnection({ host: url.hostname, port: Number(url.port) })
  socket.setTimeout(2_000, () => socket.destroy(new Error('Upgrade did not complete')))
  await once(socket, 'connect')
  socket.end(
    [
      'GET /api/events HTTP/1.1',
      `Host: ${url.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n')
  )
  const chunks: Buffer[] = []
  for await (const chunk of socket) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

async function requestStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { headers }, response => {
      response.resume()
      resolve(response.statusCode!)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

test('rejects every unauthenticated HTTP route before application handlers', async () => {
  const { origin } = await start()
  for (const path of ['/', '/api/settings.describe', '/wework/electron-host/v1/invoke']) {
    const response = await fetch(origin + path)
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
  }
  expect((await fetch(origin + '/?token=wrong')).status).toBe(401)
})

test('exchanges a one-time private credential for an authority-bound browser cookie', async () => {
  const { origin, bootstrap } = await start()
  const cookie = await authenticate(bootstrap)
  expect((await fetch(bootstrap)).status).toBe(401)
  const response = await fetch(origin + '/api/settings.describe', { headers: { cookie } })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('application')
  expect((await fetch(origin, { headers: { cookie: cookie + 'wrong' } })).status).toBe(401)
})

test('rejects cross-origin, cross-site, and wrong-authority requests even with the cookie', async () => {
  const { origin, bootstrap } = await start()
  const cookie = await authenticate(bootstrap)
  for (const headers of [
    { origin: 'https://evil.test' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { host: 'evil.test' },
  ]) {
    expect(await requestStatus(origin, { cookie, ...headers }), JSON.stringify(headers)).toBe(401)
  }
})

test('requires the same browser authentication for WebSocket upgrades', async () => {
  const { origin, bootstrap } = await start()
  expect(await upgrade(origin)).toMatch(/^HTTP\/1.1 401/)
  const cookie = await authenticate(bootstrap)
  expect(await upgrade(origin, { Cookie: cookie, Origin: 'https://evil.test' })).toMatch(
    /^HTTP\/1.1 401/
  )
  expect(await upgrade(origin, { Cookie: cookie, Origin: origin })).toMatch(/^HTTP\/1.1 101/)
})

test('does not consume the bootstrap credential on a cross-origin request', async () => {
  const { origin, bootstrap } = await start()
  expect((await fetch(bootstrap, { headers: { Origin: 'https://evil.test' } })).status).toBe(401)
  const cookie = await authenticate(bootstrap)
  expect((await fetch(origin, { headers: { cookie } })).status).toBe(200)
})

test('survives a socket error while rejecting an unauthenticated upgrade', async () => {
  const { origin, bootstrap } = await start(true)
  // A reset can arrive before the client receives the rejection response.
  await upgrade(origin).catch(() => undefined)
  const cookie = await authenticate(bootstrap)
  expect((await fetch(origin, { headers: { cookie } })).status).toBe(200)
})

test.each(['missing-pipe', 'non-loopback'])('fails closed for %s startup', mode => {
  const result = spawnSync(
    process.execPath,
    [
      '--require',
      fileURLToPath(new URL('./legacy-dsh-browser-auth.cjs', import.meta.url)),
      '-e',
      "require('node:http').createServer().listen(0, '0.0.0.0')",
    ],
    {
      env: { ...process.env, WEWORK_DSH_BROWSER_AUTH_FD: mode === 'missing-pipe' ? '' : '5' },
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'pipe'],
      timeout: 2_000,
      encoding: 'utf8',
    }
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(
    mode === 'missing-pipe' ? 'private browser authentication pipe' : 'requires IPv4 loopback'
  )
  expect(result.stdout).toBe('')
})
