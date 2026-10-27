import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'
import { createSubscriptionConfigRegression } from '../e2e/desktop/modules/stand-in-subscription-config.mjs'

function refusedUpgrade() {
  const server = createServer()
  createSubscriptionConfigRegression().attachServer(server)
  const socket = new PassThrough()
  let response = ''
  socket.on('data', data => {
    response += data.toString()
  })
  server.emit('upgrade', { url: '/backend-api/codex/responses' }, socket)
  assert.match(response, /^HTTP\/1\.1 426 Upgrade Required/)
  return socket
}

test('a peer reset after a rejected model upgrade closes only that connection', () => {
  const socket = refusedUpgrade()
  assert.doesNotThrow(() =>
    socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
  )
  assert.equal(socket.destroyed, true)
})

test('unexpected rejected-upgrade socket errors still fail the test', () => {
  const socket = refusedUpgrade()
  const error = Object.assign(new Error('unexpected I/O failure'), { code: 'EIO' })
  assert.throws(
    () => socket.emit('error', error),
    value => value === error
  )
  assert.equal(socket.destroyed, true)
})
