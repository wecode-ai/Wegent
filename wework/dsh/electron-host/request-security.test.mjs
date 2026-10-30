import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { createRequestSecurity } from './request-security.js'

function securityFixture(port = 3000) {
  let calls = 0
  const security = createRequestSecurity(
    {
      requestRejection(req) {
        calls += 1
        return req.headers.cookie === 'session=authenticated' ? undefined : 401
      },
    },
    port
  )
  return { security, calls: () => calls }
}

function invoke(security, headers = {}, remoteAddress = '127.0.0.1', rawHeaders) {
  let dispatched = false
  const response = {
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
  security.wrap(() => {
    dispatched = true
  })(
    {
      socket: { remoteAddress },
      headers: { host: '127.0.0.1:3000', cookie: 'session=authenticated', ...headers },
      rawHeaders,
    },
    response
  )
  return { ...response, dispatched }
}

test('requires DSH browser authentication rather than silently accepting old runtimes', () => {
  assert.throws(() => createRequestSecurity({}, 3000), /require authenticated DSH/)
  assert.throws(() => securityFixture(0), /requires the listening port/)
})

test('accepts authenticated loopback authorities and socket address forms', () => {
  const { security } = securityFixture()
  for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const result = invoke(security, { host, origin: `http://${host}` }, remote)
      assert.equal(result.dispatched, true, `${host} / ${remote}`)
    }
  }
})

test('rejects rebinding with matching hostile Host and Origin, even with a valid cookie', () => {
  const { security, calls } = securityFixture()
  for (const origin of ['http://rebind.attacker.test:3000', undefined]) {
    const result = invoke(security, {
      host: 'rebind.attacker.test:3000',
      origin,
      'sec-fetch-site': 'same-origin',
    })
    assert.equal(result.status, 403)
    assert.equal(result.dispatched, false)
  }
  assert.equal(calls(), 0)
})

test('requires a literal loopback Host with the listening port', () => {
  const { security } = securityFixture()
  for (const host of [
    undefined,
    ['127.0.0.1:3000'],
    '127.0.0.1',
    '127.0.0.1:3001',
    '127.0.0.1:03000',
    '127.1:3000',
    '2130706433:3000',
    '0x7f000001:3000',
    'localhost.:3000',
    'localhost.evil.test:3000',
    'evil@127.0.0.1:3000',
    '127.0.0.1:3000/path',
    ' 127.0.0.1:3000',
    '127.0.0.1:3000,evil.test',
  ]) {
    assert.equal(invoke(security, { host }).status, 403, String(host))
  }
  assert.equal(invoke(security, {}, '10.0.0.8').status, 403)
  assert.equal(
    invoke(security, {}, '127.0.0.1', ['Host', '127.0.0.1:3000', 'host', 'evil.test:3000']).status,
    403
  )
})

test('rejects foreign, opaque, malformed, or non-HTTP origins and cross-site metadata', () => {
  const { security } = securityFixture()
  for (const origin of [
    'null',
    'bad',
    'http://evil.test',
    'https://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    ['http://127.0.0.1:3000'],
  ]) {
    assert.equal(invoke(security, { origin }).status, 403)
  }
  for (const fetchSite of ['cross-site', 'same-site', ['same-origin']]) {
    assert.equal(invoke(security, { 'sec-fetch-site': fetchSite }).status, 403)
  }
})

test('requires authentication even when Origin and Fetch Metadata are absent', () => {
  const { security, calls } = securityFixture()
  for (const cookie of [undefined, '', 'session=forged']) {
    const result = invoke(security, { cookie })
    assert.equal(result.status, 401)
    assert.equal(result.dispatched, false)
    assert.equal(result.headers['cache-control'], 'no-store')
  }
  assert.equal(calls(), 3)
})

test('authenticates upgrades before opening a backend WebSocket', () => {
  const { security } = securityFixture()
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000' } }
  let output
  let dispatched = false
  const upgrade = security.wrapUpgrade(() => {
    dispatched = true
  })
  upgrade(
    req,
    {
      end: body => {
        output = body
      },
    },
    Buffer.alloc(0)
  )
  assert.match(output, /^HTTP\/1.1 401 /)
  assert.equal(dispatched, false)
  req.headers.cookie = 'session=authenticated'
  upgrade(req, {}, Buffer.alloc(0))
  assert.equal(dispatched, true)
})

test('blocks the reported PoC on a real listening HTTP server before dispatch', async t => {
  let dispatched = 0
  let security
  const server = createServer((req, res) =>
    security.wrap((_req, response) => {
      dispatched += 1
      response.writeHead(200)
      response.end('{}')
    })(req, res)
  )
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  security = securityFixture(port).security
  const response = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/wework/terminal/v1/rpc',
        headers: {
          host: `rebind.attacker.test:${port}`,
          origin: `http://rebind.attacker.test:${port}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
      },
      res => {
        res.resume()
        res.on('end', () => resolve(res))
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify({ method: 'terminal.start', params: {} }))
  })
  assert.equal(response.statusCode, 403)
  assert.equal(dispatched, 0)
})
