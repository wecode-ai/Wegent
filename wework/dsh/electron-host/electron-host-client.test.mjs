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

const DIALOG_CASES = [
  {
    capability: 'dialog.open',
    completed: { canceled: false, filePaths: ['/project'] },
    canceled: { canceled: true, filePaths: [] },
  },
  {
    capability: 'dialog.save',
    completed: { canceled: false, filePath: '/report.txt' },
    canceled: { canceled: true, filePath: '' },
  },
  {
    capability: 'dialog.message',
    completed: { response: 0, checkboxChecked: false },
    canceled: { response: 1, checkboxChecked: false },
  },
]

for (const { capability, completed, canceled } of DIALOG_CASES) {
  for (const [outcome, result] of Object.entries({ completed, canceled })) {
    test(`${capability} returns a ${outcome} result after a long user interaction`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const { client, requests, respond } = await startHost(t, [capability])
      const invocation = client.invoke(capability)
      const settled = t.mock.fn()
      void invocation.then(settled, settled)
      await new Promise(resolve => setImmediate(resolve))

      // Advance well beyond the production 120-second request timeout.
      t.mock.timers.tick(600_000)
      await new Promise(resolve => setImmediate(resolve))

      assert.equal(settled.mock.callCount(), 0)
      assert.equal(requests.length, 1)
      assert.equal(client.pending.size, 1)
      respond(requests[0], { ok: true, result })

      assert.deepEqual(await invocation, result)
      assert.equal(client.pending.size, 0)
    })
  }
}

test('ordinary requests still time out while a native dialog waits for the user', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, requests, respond } = await startHost(t, ['dialog.open', 'window.getState'])
  const dialog = client.invoke('dialog.open')
  const ordinaryRequest = assert.rejects(
    client.invoke('window.getState'),
    error =>
      error instanceof ElectronHostError &&
      error.code === 'host_timeout' &&
      error.message === 'Electron host request timed out: window.getState'
  )
  await new Promise(resolve => setImmediate(resolve))

  t.mock.timers.tick(120_000)
  await ordinaryRequest

  assert.equal(client.pending.size, 1)
  const result = { canceled: false, filePaths: ['/project'] }
  respond(
    requests.find(request => request.capability === 'dialog.open'),
    { ok: true, result }
  )
  assert.deepEqual(await dialog, result)
  assert.equal(client.pending.size, 0)
})

for (const reason of ['host_disconnected', 'client_closed']) {
  test(`pending native dialogs are rejected and cleaned up on ${reason}`, async t => {
    const { client, hostToDsh } = await startHost(
      t,
      DIALOG_CASES.map(({ capability }) => capability)
    )
    const rejections = DIALOG_CASES.map(({ capability }) =>
      assert.rejects(
        client.invoke(capability),
        error => error instanceof ElectronHostError && error.code === reason
      )
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(client.pending.size, DIALOG_CASES.length)

    if (reason === 'host_disconnected') hostToDsh.end()
    else client.stop()

    await Promise.all(rejections)
    assert.equal(client.pending.size, 0)
  })
}

test('native dialog failures are preserved and cleaned up', async t => {
  const { client, requests, respond } = await startHost(t, ['dialog.open'])
  const rejection = assert.rejects(
    client.invoke('dialog.open'),
    error =>
      error instanceof ElectronHostError &&
      error.code === 'capability_failed' &&
      error.message === 'Native dialog failed' &&
      error.details.capability === 'dialog.open'
  )
  await new Promise(resolve => setImmediate(resolve))

  respond(requests[0], {
    ok: false,
    error: {
      code: 'capability_failed',
      message: 'Native dialog failed',
      details: { capability: 'dialog.open' },
    },
  })

  await rejection
  assert.equal(client.pending.size, 0)
})

test('native dialog requests are cleaned up when the host pipe cannot be written', async t => {
  const { client, dshToHost } = await startHost(t, ['dialog.open'])
  dshToHost.destroy()

  await assert.rejects(
    client.invoke('dialog.open'),
    error => error instanceof ElectronHostError && error.code === 'host_disconnected'
  )

  assert.equal(client.pending.size, 0)
})

async function startHost(t, capabilities) {
  const hostToDsh = new PassThrough()
  const dshToHost = new PassThrough()
  const client = new ElectronHostClient({
    token: 'test-token',
    input: hostToDsh,
    output: dshToHost,
  })
  t.after(() => {
    client.stop()
    hostToDsh.destroy()
    dshToHost.destroy()
  })
  const requests = []
  dshToHost.on('data', chunk => {
    const message = JSON.parse(chunk.toString('utf8'))
    if (message.type === 'hello') {
      hostToDsh.write(
        `${JSON.stringify({
          type: 'hello',
          ok: true,
          protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
          capabilities,
        })}\n`
      )
    } else {
      requests.push(message)
    }
  })
  await client.start()
  return {
    client,
    hostToDsh,
    dshToHost,
    requests,
    respond(request, response) {
      hostToDsh.write(`${JSON.stringify({ type: 'response', id: request.id, ...response })}\n`)
    },
  }
}
