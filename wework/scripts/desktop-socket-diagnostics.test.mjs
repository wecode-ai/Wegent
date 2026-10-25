import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'vitest'

const diagnosticsUrl = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../e2e/desktop/socket-diagnostics.mjs')
).href
const modelConnectionsUrl = pathToFileURL(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../e2e/desktop/modules/model-server-connections.mjs'
  )
).href

function run(script) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { installSocketDiagnostics } from ${JSON.stringify(diagnosticsUrl)}
       import { trackModelServerConnections } from ${JSON.stringify(modelConnectionsUrl)}
       const setSocketDiagnosticPhase = installSocketDiagnostics()
       ${script}`,
    ],
    { encoding: 'utf8', timeout: 5000 }
  )
}

test('identifies the client socket while preserving an unhandled error exit', () => {
  const result = run(`
    import { createServer, connect } from 'node:net'
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const socket = connect(server.address().port, '127.0.0.1', () => {
        socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      })
    })
  `)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Unhandled socket error .*"owner":"net.client"/)
  assert.match(result.stderr, /"code":"ECONNRESET"/)
  assert.match(result.stderr, /Unhandled 'error' event/)
})

test('identifies child stdout without consuming its fatal error', () => {
  const result = run(`
    import { spawn } from 'node:child_process'
    const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('spawn', () => {
      child.stdout.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    })
  `)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Unhandled socket error .*"owner":"child.stdio"/)
  assert.match(result.stderr, /"fd":1/)
  assert.match(result.stderr, /Unhandled 'error' event/)
})

test('identifies an accepted server socket while preserving its fatal error', () => {
  const result = run(`
    import { createServer, connect } from 'node:net'
    const server = createServer(socket => {
      setImmediate(() => {
        socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      })
    })
    server.listen(0, '127.0.0.1', () => connect(server.address().port, '127.0.0.1'))
  `)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Unhandled socket error .*"owner":"net.server"/)
  assert.match(result.stderr, /Unhandled 'error' event/)
})

test('leaves handled socket errors with their existing owner', () => {
  const result = run(`
    import { createServer, connect } from 'node:net'
    const server = createServer(socket => socket.end())
    server.listen(0, '127.0.0.1', () => {
      const socket = connect(server.address().port, '127.0.0.1', () => {
        socket.emit('error', new Error('handled'))
        socket.end()
        server.close()
      })
      socket.on('error', () => {})
    })
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
})

test('retains server ownership and ports when an error follows socket closure', () => {
  const result = run(`
    import { createServer, connect } from 'node:net'
    const server = createServer(socket => {
      socket.once('close', () => {
        server.close()
        setSocketDiagnosticPhase('teardown:desktop application')
        socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      })
      socket.destroy()
    })
    server.listen(0, '127.0.0.1', () => {
      connect(server.address().port, '127.0.0.1').on('error', () => {})
    })
  `)
  assert.equal(result.status, 1, result.stderr)
  const line = result.stderr
    .split('\n')
    .find(value => value.startsWith('[desktop-e2e] Unhandled socket error '))
  assert.ok(line, result.stderr)
  const record = JSON.parse(line.slice('[desktop-e2e] Unhandled socket error '.length))
  assert.equal(record.owner, 'net.server')
  assert.equal(typeof record.localPort, 'number')
  assert.equal(typeof record.remotePort, 'number')
  assert.match(record.serverListenStack, /\[eval1\]/)
  assert.equal(record.phase, 'teardown:desktop application')
  assert.match(result.stderr, /Unhandled 'error' event/)
})

test('owns a model peer reset while the scenario is still running', () => {
  const result = run(`
    import { createServer, connect } from 'node:net'
    let client
    const server = createServer(socket => {
      socket.once('data', () => client.resetAndDestroy())
      socket.once('close', () => server.close())
    })
    trackModelServerConnections(server)
    server.listen(0, '127.0.0.1', () => {
      client = connect(server.address().port, '127.0.0.1', () => client.write('ready'))
    })
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
})

test('leaves unrelated controller peer resets fatal', () => {
  const result = run(`
    import { createServer, connect } from 'node:net'
    trackModelServerConnections(createServer())
    let client
    const controller = createServer(socket => {
      socket.once('data', () => client.resetAndDestroy())
    })
    controller.listen(0, '127.0.0.1', () => {
      client = connect(controller.address().port, '127.0.0.1', () => client.write('ready'))
    })
  `)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Unhandled 'error' event/)
  assert.match(result.stderr, /ECONNRESET/)
})

for (const code of ['ECONNRESET', 'EIO']) {
  test(`retains model ownership after HTTP completes and removes its handlers: ${code}`, () => {
    const result = run(`
      import { createServer } from 'node:http'
      import { connect } from 'node:net'
      const server = createServer((request, response) => response.end('complete'))
      trackModelServerConnections(server)
      server.on('connection', socket => {
        socket.once('close', () => {
          server.close()
          socket.emit('error', Object.assign(new Error('late HTTP socket error'), {
            code: ${JSON.stringify(code)},
          }))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const client = connect(server.address().port, '127.0.0.1', () => {
          client.write('GET /responses HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
        })
        client.once('data', bytes => {
          if (!bytes.toString().startsWith('HTTP/1.1 200')) throw new Error('Invalid HTTP fixture')
        })
        client.resume()
        client.on('error', () => {})
      })
    `)
    assert.equal(result.status, code === 'ECONNRESET' ? 0 : 1, result.stderr)
    if (code === 'ECONNRESET') assert.equal(result.stderr, '')
    else assert.match(result.stderr, /late HTTP socket error/)
  })
}
