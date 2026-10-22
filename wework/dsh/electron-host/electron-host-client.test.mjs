import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  ELECTRON_HOST_PROTOCOL_VERSION,
  ElectronHostClient,
  ElectronHostError,
} from './electron-host-client.js'

test('negotiates capabilities and invokes the Electron host', async () => {
  const hostToDsh = new PassThrough()
  const dshToHost = new PassThrough()
  const client = new ElectronHostClient({
    token: 'test-token',
    input: hostToDsh,
    output: dshToHost,
  })
  let requestBuffer = ''
  dshToHost.setEncoding('utf8')
  dshToHost.on('data', chunk => {
    requestBuffer += chunk
    for (;;) {
      const newline = requestBuffer.indexOf('\n')
      if (newline < 0) break
      const line = requestBuffer.slice(0, newline)
      requestBuffer = requestBuffer.slice(newline + 1)
      const message = JSON.parse(line)
      if (message.type === 'hello') {
        assert.equal(message.token, 'test-token')
        hostToDsh.write(
          `${JSON.stringify({
            type: 'hello',
            ok: true,
            protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
            capabilities: ['window.getState'],
          })}\n`
        )
        continue
      }
      hostToDsh.write(
        `${JSON.stringify({
          type: 'response',
          id: message.id,
          ok: true,
          result: { maximized: false },
        })}\n`
      )
    }
  })

  assert.deepEqual(await client.start(), {
    protocolVersion: 1,
    capabilities: ['window.getState'],
  })
  assert.deepEqual(await client.invoke('window.getState'), { maximized: false })
  client.stop()
})

test('sends the workbench principal in its handshake', async () => {
  const hostToDsh = new PassThrough()
  const dshToHost = new PassThrough()
  const client = new ElectronHostClient({
    token: 'test-token',
    input: hostToDsh,
    output: dshToHost,
    principal: '@wegent/dsh-workbench',
  })
  dshToHost.once('data', chunk => {
    const message = JSON.parse(chunk.toString('utf8'))
    assert.equal(message.principal, '@wegent/dsh-workbench')
    hostToDsh.write(
      `${JSON.stringify({
        type: 'hello',
        ok: true,
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        capabilities: [],
      })}\n`
    )
  })

  await client.start()
  client.stop()
})

test('accepts host responses larger than the previous one MiB limit', async () => {
  const hostToDsh = new PassThrough()
  const dshToHost = new PassThrough()
  const client = new ElectronHostClient({
    token: 'test-token',
    input: hostToDsh,
    output: dshToHost,
  })
  const largeValue = 'x'.repeat(2 * 1024 * 1024)
  let requestBuffer = ''
  dshToHost.setEncoding('utf8')
  dshToHost.on('data', chunk => {
    requestBuffer += chunk
    for (;;) {
      const newline = requestBuffer.indexOf('\n')
      if (newline < 0) break
      const line = requestBuffer.slice(0, newline)
      requestBuffer = requestBuffer.slice(newline + 1)
      const message = JSON.parse(line)
      if (message.type === 'hello') {
        hostToDsh.write(
          `${JSON.stringify({
            type: 'hello',
            ok: true,
            protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
            capabilities: ['preferences.get'],
          })}\n`
        )
        continue
      }
      hostToDsh.write(
        `${JSON.stringify({
          type: 'response',
          id: message.id,
          ok: true,
          result: { largeValue },
        })}\n`
      )
    }
  })

  await client.start()
  assert.deepEqual(await client.invoke('preferences.get'), { largeValue })
  client.stop()
})

test('rejects capabilities not granted by Electron', async () => {
  const hostToDsh = new PassThrough()
  const dshToHost = new PassThrough()
  const client = new ElectronHostClient({
    token: 'test-token',
    input: hostToDsh,
    output: dshToHost,
  })
  dshToHost.once('data', () => {
    hostToDsh.write(
      `${JSON.stringify({
        type: 'hello',
        ok: true,
        protocolVersion: 1,
        capabilities: [],
      })}\n`
    )
  })
  await client.start()
  await assert.rejects(
    () => client.invoke('window.close'),
    error => error instanceof ElectronHostError && error.code === 'capability_denied'
  )
  client.stop()
})

test('allows runtime preparation past the ordinary request deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hostToDsh = new PassThrough()
  const dshToHost = new PassThrough()
  const client = new ElectronHostClient({
    token: 'test-token',
    input: hostToDsh,
    output: dshToHost,
  })
  dshToHost.once('data', () =>
    hostToDsh.write(
      `${JSON.stringify({
        type: 'hello',
        ok: true,
        protocolVersion: 1,
        capabilities: ['smartApps.start', 'smartApps.verify', 'window.getState'],
      })}\n`
    )
  )
  await client.start()
  try {
    for (const capability of ['smartApps.start', 'smartApps.verify']) {
      let request
      dshToHost.once('data', chunk => {
        request = JSON.parse(chunk.toString())
      })
      const pending = client.invoke(capability)
      await new Promise(setImmediate)
      t.mock.timers.tick(120_001)
      hostToDsh.write(
        `${JSON.stringify({ type: 'response', id: request.id, ok: true, result: 'ready' })}\n`
      )
      assert.equal(await pending, 'ready')
    }
    const ordinary = assert.rejects(client.invoke('window.getState'), { code: 'host_timeout' })
    await new Promise(setImmediate)
    t.mock.timers.tick(120_001)
    await ordinary
  } finally {
    client.stop()
  }
})

test('reports an unexpected Electron host pipe close exactly once', async () => {
  const hostToDsh = new PassThrough()
  const dshToHost = new PassThrough()
  const disconnects = []
  const client = new ElectronHostClient({
    token: 'test-token',
    input: hostToDsh,
    output: dshToHost,
    onDisconnect: error => disconnects.push(error),
  })
  dshToHost.once('data', () => {
    hostToDsh.write(
      `${JSON.stringify({
        type: 'hello',
        ok: true,
        protocolVersion: 1,
        capabilities: [],
      })}\n`
    )
  })

  await client.start()
  hostToDsh.end()
  await new Promise(resolve => setImmediate(resolve))
  hostToDsh.destroy()

  assert.equal(disconnects.length, 1)
  assert.equal(disconnects[0].code, 'host_disconnected')
})
