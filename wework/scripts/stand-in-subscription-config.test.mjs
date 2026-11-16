// @vitest-environment node

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'
import { createDesktopScenario as createNotifications } from '../e2e/desktop/scenarios/stand-in-notifications.scenario.mjs'
import { createDesktopScenario as createModelExecution } from '../e2e/desktop/scenarios/stand-in-model-execution.scenario.mjs'
import { REPLY_PREDICTION_PROMPT } from '../e2e/desktop/modules/response-protocol.mjs'
import {
  assertSubscriptionModelRequest,
  createSubscriptionConfigRegression,
  implicitSubscriptionTask,
} from '../e2e/desktop/modules/stand-in-subscription-config.mjs'

test.each([
  ['notifications', createNotifications],
  ['model execution', createModelExecution],
])('%s handles reply prediction before validating subscription task models', async (_, create) => {
  const scenario = create({ uiTimeoutMs: 1000, modelResponseTimeoutMs: 1000 })
  const request = text => {
    const stream = new PassThrough()
    stream.method = 'POST'
    stream.headers = {}
    stream.end(JSON.stringify({ model: 'gpt-5.6-sol', input: [{ role: 'user', content: text }] }))
    return stream
  }
  let status
  let output
  const response = {
    writeHead(value) {
      status = value
    },
    end(value) {
      output = value
    },
  }
  const url = new URL('http://model.test/backend-api/codex/responses')
  assert.equal(await scenario.handleHttp(request(REPLY_PREDICTION_PROMPT), response, url), true)
  assert.equal(status, 200)
  const events = output
    .split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)))
  const answer = events.find(event => event.item?.role === 'assistant')
  assert.deepEqual(JSON.parse(answer.item.content[0].text), { suggestion: null })
  await assert.rejects(
    () => scenario.handleHttp(request('SUBSCRIPTION_CONFIG_RELOAD-user'), response, url),
    { code: 'ERR_ASSERTION', actual: 'gpt-5.6-sol', expected: 'gpt-6.1-sol' }
  )
})

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
