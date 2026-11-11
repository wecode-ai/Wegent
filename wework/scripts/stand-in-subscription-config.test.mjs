// @vitest-environment node

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'
import {
  assertSubscriptionModelRequest,
  createSubscriptionConfigRegression,
  implicitSubscriptionTask,
} from '../e2e/desktop/modules/stand-in-subscription-config.mjs'

test('the implicit subscription regression submits no explicit fallback model', () => {
  const task = implicitSubscriptionTask(41, '/fixture/workspace')
  for (const key of ['modelSelection', 'modelId', 'modelOptions', 'modelConfig']) {
    assert.equal(Object.hasOwn(task, key), false)
  }
  assert.deepEqual(task.executionRequest.model_config, {})
  assert.equal(task.executionRequest.user_id, 41)
  assert.equal(task.workspacePath, '/fixture/workspace')
  assert.equal(task.executionRequest.new_session, true)
  assert.equal(task.executionRequest.prompt, task.message)
})

test('the model service requires the measured default and exact subscription identity', () => {
  const request = {
    headers: {
      authorization: 'Bearer synthetic-subscription-access',
      'chatgpt-account-id': 'stand-in-config-e2e',
    },
  }
  assert.doesNotThrow(() =>
    assertSubscriptionModelRequest(request, { model: 'catalog-default' }, 'catalog-default')
  )
  assert.throws(() =>
    assertSubscriptionModelRequest(request, { model: 'gpt-5.5' }, 'catalog-default')
  )
  assert.throws(() =>
    assertSubscriptionModelRequest(request, { model: 'gpt-6.1-sol' }, 'catalog-default')
  )
  assert.doesNotThrow(() => assertSubscriptionModelRequest(request, { model: 'gpt-6.1-sol' }))
  for (const headers of [
    { ...request.headers, authorization: 'Bearer unrelated-api-key' },
    { ...request.headers, 'chatgpt-account-id': 'unrelated-account' },
  ]) {
    assert.throws(() =>
      assertSubscriptionModelRequest({ headers }, { model: 'catalog-default' }, 'catalog-default')
    )
  }
})

function refusedUpgrade(url = '/backend-api/codex/responses') {
  const server = createServer()
  createSubscriptionConfigRegression().attachServer(server)
  const socket = new PassThrough()
  let response = ''
  socket.on('data', data => {
    response += data.toString()
  })
  server.emit('upgrade', { url }, socket)
  assert.match(response, /^HTTP\/1\.1 426 Upgrade Required/)
  return socket
}

test('a peer reset after a rejected model upgrade closes only that connection', () => {
  const socket = refusedUpgrade()
  for (let count = 0; count < 2; count += 1) {
    assert.doesNotThrow(() =>
      socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    )
  }
  assert.equal(socket.destroyed, true)
})

test('the HTTP model fixture owns every rejected upgrade socket', () => {
  for (const url of ['/responses', '/v1/responses', '/unknown']) {
    const socket = refusedUpgrade(url)
    assert.doesNotThrow(() =>
      socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    )
    assert.equal(socket.destroyed, true)
  }
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
