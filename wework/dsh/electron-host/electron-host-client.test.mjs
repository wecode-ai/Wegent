import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

test('inherited pipe input avoids the filesystem pool and survives client generations', async () => {
  const moduleUrl = pathToFileURL(resolve('dsh/electron-host/electron-host-client.js')).href
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { ElectronHostClient } from ${JSON.stringify(moduleUrl)}
    let previousInput
    for (let generation = 0; generation < 2; generation++) {
      const client = ElectronHostClient.fromEnvironment(process.env)
      if (previousInput && previousInput !== client.input) throw new Error('input ownership changed')
      const listenersBefore = ['end', 'error', 'close', 'data'].map(event => client.input.listenerCount(event))
      await client.start()
      const result = await client.invoke('rendererStorage.initialize', { entries: {} })
      if (result.data.length !== 79000) throw new Error('response truncated')
      previousInput = client.input
      client.stop()
      if (client.input.destroyed) throw new Error('inherited input closed')
      const listenersAfter = ['end', 'error', 'close', 'data'].map(event => client.input.listenerCount(event))
      if (JSON.stringify(listenersAfter) !== JSON.stringify(listenersBefore)) {
        throw new Error('client listeners leaked')
      }
    }
    process.stdout.write('complete')
  `,
    ],
    {
      env: {
        ...process.env,
        UV_THREADPOOL_SIZE: '1',
        WEWORK_ELECTRON_HOST_PROTOCOL: '1',
        WEWORK_ELECTRON_HOST_TOKEN: 'synthetic-pipe-test',
        WEWORK_ELECTRON_HOST_REQUEST_FD: '3',
        WEWORK_ELECTRON_HOST_RESPONSE_FD: '4',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    }
  )
  let output = ''
  let errorOutput = ''
  child.stdout.on('data', chunk => {
    output += chunk
  })
  child.stderr.on('data', chunk => {
    errorOutput += chunk
  })
  const lines = createInterface({ input: child.stdio[4] })
  let handshakes = 0
  let requests = 0
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.type === 'hello') {
      handshakes++
      assert.equal(message.token, 'synthetic-pipe-test')
      assert.equal(message.principal, '@wegent/dsh-app-wework')
      child.stdio[3].write(
        JSON.stringify({
          type: 'hello',
          ok: true,
          protocolVersion: 1,
          capabilities: ['rendererStorage.initialize'],
        }) + '\n'
      )
    } else if (message.type === 'request') {
      requests++
      child.stdio[3].write(
        JSON.stringify({
          type: 'response',
          id: message.id,
          ok: true,
          result: { data: 'x'.repeat(79000) },
        }) + '\n'
      )
    }
  })
  const exited = new Promise(resolveExit =>
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  )
  const deadline = setTimeout(() => {
    child.stdio[3].end()
    child.kill('SIGKILL')
  }, 3000)
  try {
    const result = await exited
    assert.deepEqual(result, { code: 0, signal: null }, errorOutput)
    assert.equal(output, 'complete')
    assert.equal(handshakes, 2)
    assert.equal(requests, 2)
  } finally {
    clearTimeout(deadline)
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('input errors reject pending requests and detach only the stopped client', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const disconnected = []
  const client = new ElectronHostClient({
    token: 'synthetic',
    input,
    output,
    onDisconnect: error => disconnected.push(error),
  })
  output.on('data', data => {
    if (JSON.parse(data).type === 'hello') {
      input.write(
        JSON.stringify({
          type: 'hello',
          ok: true,
          protocolVersion: 1,
          capabilities: ['window.getState'],
        }) + '\n'
      )
    }
  })
  await client.start()
  const pending = client.invoke('window.getState')
  await Promise.resolve()
  const error = new ElectronHostError('host_disconnected', 'synthetic pipe failure')
  input.emit('error', error)
  await assert.rejects(pending, failure => failure === error)
  assert.deepEqual(disconnected, [error])
  assert.equal(client.pending.size, 0)
  assert.equal(input.listeners('end').includes(client.onInputEnd), false)
  assert.equal(input.listeners('close').includes(client.onInputClose), false)
  assert.equal(input.listeners('error').includes(client.onInputError), false)
  assert.equal(input.destroyed, false)
  output.end()
})
