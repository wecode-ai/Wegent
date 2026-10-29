import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'vitest'

import { attachCodexModelWebSocket } from '../e2e/desktop/scenarios/codex-invalid-launch-cwd.scenario.mjs'

class ModelSocket extends EventEmitter {
  destroyed = false
  writes = []
  responseError

  write(value) {
    this.writes.push(value)
    if (this.responseError && Buffer.isBuffer(value)) this.emit('error', this.responseError)
    return !this.destroyed
  }

  destroy() {
    this.destroyed = true
    this.emit('close')
  }
}

function sendRequest(socket, body) {
  const payload = Buffer.from(JSON.stringify({ type: 'response.create', ...body }))
  const header = Buffer.alloc(payload.length < 126 ? 6 : 8)
  header[0] = 0x81
  header[1] = 0x80 | (payload.length < 126 ? payload.length : 126)
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2)
  // An all-zero mask is valid and keeps the fixture payload readable.
  socket.emit('data', Buffer.concat([header, payload]))
}

function fixture() {
  const server = new EventEmitter()
  const errors = []
  const foreground = []
  server.on('error', error => errors.push(error))
  const close = attachCodexModelWebSocket(server, {
    modelServerUrl: 'http://localhost:12345',
    isVerificationComplete: () => false,
    onForegroundRequest: body => foreground.push(body),
  })
  const connect = () => {
    const socket = new ModelSocket()
    server.emit(
      'upgrade',
      { url: '/v1/responses', headers: { 'sec-websocket-key': 'fixture-key' } },
      socket,
      Buffer.alloc(0)
    )
    return socket
  }
  return { connect, foreground, errors, close }
}

const prediction = {
  client_metadata: {
    'x-codex-turn-metadata': JSON.stringify({ thread_source: 'composer_predictions' }),
  },
}

test('WebSocket predictions return no suggestion without consuming foreground turns', () => {
  const model = fixture()
  try {
    const socket = model.connect()
    sendRequest(socket, { generate: false })
    sendRequest(socket, prediction)
    assert.equal(model.foreground.length, 0)
    assert.match(socket.writes.at(-1).toString(), /suggestion\\":null/)
    sendRequest(socket, { input: 'foreground prompt' })
    assert.equal(model.foreground.length, 1)
    assert.match(socket.writes.at(-1).toString(), /INVALID_LAUNCH_CWD_COMPLETE/)
    assert.deepEqual(model.errors, [])
  } finally {
    model.close()
  }
})

test.each(['EPIPE', 'ECONNRESET'])(
  'cancelled predictions tolerate %s during model writes',
  code => {
    const model = fixture()
    try {
      const socket = model.connect()
      socket.responseError = Object.assign(new Error('peer cancelled'), { code })
      sendRequest(socket, prediction)
      assert.equal(socket.destroyed, true)
      assert.deepEqual(model.errors, [])
      sendRequest(model.connect(), { input: 'foreground prompt' })
      assert.equal(model.foreground.length, 1)
    } finally {
      model.close()
    }
  }
)

test.each([
  ['foreground', { input: 'foreground prompt' }, 'EPIPE'],
  ['foreground', { input: 'foreground prompt' }, 'ECONNRESET'],
  ['prediction', prediction, 'EIO'],
])('%s transport failures with %s remain checkpoint failures', (_kind, body, code) => {
  const model = fixture()
  try {
    const socket = model.connect()
    const failure = Object.assign(new Error('transport failed'), { code })
    socket.responseError = failure
    sendRequest(socket, body)
    assert.deepEqual(model.errors, [failure])
    assert.equal(socket.destroyed, true)
  } finally {
    model.close()
  }
})
